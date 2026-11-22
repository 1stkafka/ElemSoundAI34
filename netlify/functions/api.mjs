// 소음 지킴이 실시간 수업방 API (Netlify Functions v2 + Netlify Blobs)
// 방(room) = 학년 + 차시 + 반. 예) L2-C3 = 3학년 2차시 3반, G4-L2-C3 = 4학년 2차시 3반
// (3학년은 처음 만든 방 이름을 그대로 써서 이미 저장된 답이 유지된다)
//   {room}/state        : 교사가 정한 진행 단계, 공개한 문항, 공개 답 스냅숏, 접속 수
//   {room}/ans/{sid}    : 학생 한 명의 답 모음
//   {room}/pres/{sid}   : 학생 접속 표시(마지막 접속 시각)
import { getStore } from "@netlify/blobs";

const ONLINE_MS = 45_000;
const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });

const teacherPin = () =>
  (globalThis.Netlify?.env?.get?.("TEACHER_PIN") || process.env.TEACHER_PIN || "0000").trim();

const sidOf = (group, name) => Buffer.from(`${group}|${name}`, "utf8").toString("base64url");
const clip = (s, n) => String(s ?? "").slice(0, n);

function cleanValue(v) {
  if (v && typeof v === "object" && !Array.isArray(v)) {
    const out = {};
    for (const [k, x] of Object.entries(v).slice(0, 40)) out[clip(k, 10)] = clip(x, 300);
    return out;
  }
  return clip(v, 2000);
}

async function readAll(store, prefix) {
  const { blobs } = await store.list({ prefix });
  const docs = await Promise.all(blobs.map((b) => store.get(b.key, { type: "json" }).then((d) => [b.key, d])));
  return docs.filter(([, d]) => d);
}

async function getState(store, room) {
  return (await store.get(`${room}/state`, { type: "json" })) || { step: 0, reveal: {}, revealed: {}, online: 0, updated: 0 };
}

function snapshot(state, students) {
  const revealed = {};
  for (const qid of Object.keys(state.reveal || {})) {
    if (!state.reveal[qid]) continue;
    revealed[qid] = students
      .filter((s) => s.answers && s.answers[qid] !== undefined && s.answers[qid] !== "")
      .map((s) => ({ group: s.group, name: s.name, value: s.answers[qid] }))
      .sort((a, b) => a.group.localeCompare(b.group, "ko") || a.name.localeCompare(b.name, "ko"));
  }
  return revealed;
}

export default async (req) => {
  const url = new URL(req.url);
  const action = url.pathname.replace(/^\/api\/?/, "").split("/")[0];
  let body = {};
  if (req.method === "POST") body = await req.json().catch(() => ({}));
  const p = (k) => String(body[k] ?? url.searchParams.get(k) ?? "");

  const room = p("room");
  if (!/^(G4-)?L[1-5]-C[1-9]$/.test(room)) return json({ error: "방 정보가 올바르지 않아요." }, 400);
  const store = getStore({ name: "soundbot-class", consistency: "strong" });

  const isTeacher = () => p("pin") === teacherPin();

  // ---------- 학생 ----------
  if (action === "state" && req.method === "GET") {
    const st = await getState(store, room);
    return json({ step: st.step, reveal: st.reveal, revealed: st.revealed, online: st.online, updated: st.updated });
  }

  if (action === "mine" && req.method === "GET") {
    const group = clip(p("group"), 10), name = clip(p("name"), 20).trim();
    if (!group || !name) return json({ error: "모둠과 이름이 필요해요." }, 400);
    const doc = await store.get(`${room}/ans/${sidOf(group, name)}`, { type: "json" });
    return json({ answers: doc?.answers || {} });
  }

  if (action === "answer" && req.method === "POST") {
    const group = clip(p("group"), 10), name = clip(p("name"), 20).trim(), qid = clip(p("qid"), 10);
    if (!group || !name || !/^q\d{1,2}$/.test(qid)) return json({ error: "모둠, 이름, 문항이 필요해요." }, 400);
    const key = `${room}/ans/${sidOf(group, name)}`;
    const doc = (await store.get(key, { type: "json" })) || { group, name, answers: {}, times: {} };
    doc.answers[qid] = cleanValue(body.value);
    doc.times = doc.times || {};
    doc.times[qid] = Date.now();
    doc.at = Date.now();
    await store.setJSON(key, doc);
    await store.setJSON(`${room}/pres/${sidOf(group, name)}`, { group, name, at: Date.now(), step: Number(p("step")) || 0 });
    return json({ ok: true, at: doc.at });
  }

  if (action === "ping" && req.method === "POST") {
    const group = clip(p("group"), 10), name = clip(p("name"), 20).trim();
    if (!group || !name) return json({ error: "모둠과 이름이 필요해요." }, 400);
    await store.setJSON(`${room}/pres/${sidOf(group, name)}`, { group, name, at: Date.now(), step: Number(p("step")) || 0 });
    return json({ ok: true });
  }

  // ---------- 교사 ----------
  if (["teacher", "control", "reset"].includes(action)) {
    if (!isTeacher()) return json({ error: "교사 PIN이 맞지 않아요." }, 403);
  }

  if (action === "teacher" && req.method === "GET") {
    const st = await getState(store, room);
    const ans = await readAll(store, `${room}/ans/`);
    const pres = await readAll(store, `${room}/pres/`);
    const now = Date.now();
    const bySid = {};
    for (const [key, d] of ans) bySid[key.split("/").pop()] = { ...d, lastSeen: 0 };
    for (const [key, d] of pres) {
      const sid = key.split("/").pop();
      bySid[sid] = bySid[sid] || { group: d.group, name: d.name, answers: {}, times: {} };
      bySid[sid].lastSeen = d.at;
      bySid[sid].step = d.step;
    }
    const students = Object.values(bySid).sort(
      (a, b) => a.group.localeCompare(b.group, "ko") || a.name.localeCompare(b.name, "ko"));
    const online = students.filter((s) => now - (s.lastSeen || 0) < ONLINE_MS).length;
    const revealed = snapshot(st, students);
    if (JSON.stringify(revealed) !== JSON.stringify(st.revealed || {}) || online !== st.online) {
      st.revealed = revealed;
      st.online = online;
      st.updated = now;
      await store.setJSON(`${room}/state`, st);
    }
    return json({ state: st, students, now, pinIsDefault: teacherPin() === "0000" });
  }

  if (action === "control" && req.method === "POST") {
    const st = await getState(store, room);
    if (body.step !== undefined) st.step = Math.max(0, Math.min(20, Number(body.step) || 0));
    if (body.reveal && typeof body.reveal === "object") {
      st.reveal = st.reveal || {};
      for (const [qid, on] of Object.entries(body.reveal)) {
        if (/^q\d{1,2}$/.test(qid)) {
          if (on) st.reveal[qid] = true;
          else delete st.reveal[qid];
        }
      }
      const students = (await readAll(store, `${room}/ans/`)).map(([, d]) => d);
      st.revealed = snapshot(st, students);
    }
    st.updated = Date.now();
    await store.setJSON(`${room}/state`, st);
    return json({ ok: true, state: st });
  }

  if (action === "reset" && req.method === "POST") {
    const { blobs } = await store.list({ prefix: `${room}/` });
    await Promise.all(blobs.map((b) => store.delete(b.key)));
    return json({ ok: true, deleted: blobs.length });
  }

  return json({ error: "알 수 없는 요청이에요." }, 404);
};

export const config = { path: "/api/*" };
