const ALLOWED_ORIGINS = new Set([
  "https://joracho.github.io",
  "http://localhost:3000",
  "http://127.0.0.1:5500"
]);
function corsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGINS.has(origin) ? origin : "https://joracho.github.io",
    "Access-Control-Allow-Headers": "authorization, content-type",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Vary": "Origin"
  };
}
function json(body, status, headers) {
  return new Response(JSON.stringify(body), { status, headers: { ...headers, "Content-Type": "application/json" } });
}
function decodeClaims(token) {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("Invalid bearer token.");
  const payload = parts[1].replace(/-/g, "+").replace(/_/g, "/");
  return JSON.parse(atob(payload + "=".repeat((4 - payload.length % 4) % 4)));
}
async function dataApi(path, token, options = {}) {
  const base = process.env.NEON_DATA_API_URL;
  if (!base) throw new Error("Neon Data API is not configured.");
  const response = await fetch(base.replace(/\/$/, "") + path, {
    ...options,
    headers: { Authorization: "Bearer " + token, "Content-Type": "application/json", ...(options.headers || {}) }
  });
  const raw = await response.text();
  let data = null;
  try { data = raw ? JSON.parse(raw) : null; } catch { data = { message: raw }; }
  return { response, data };
}
const enc = encodeURIComponent;
const uuidPattern = /^[0-9a-f-]{36}$/i;
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
async function getProfile(token, userId) {
  const r = await dataApi(`/profiles?select=id,email,full_name,company_name,phone,role&id=eq.${enc(userId)}&limit=1`, token);
  if (!r.response.ok) throw new Error("Unable to verify the signed-in Savannah profile.");
  return Array.isArray(r.data) ? r.data[0] || null : null;
}
async function listProfiles(token, role) {
  const filter = role ? `&role=eq.${enc(role)}` : "";
  const r = await dataApi(`/profiles?select=id,email,full_name,role&order=created_at.desc${filter}&limit=1000`, token);
  if (!r.response.ok) throw new Error("Unable to load Savannah accounts.");
  return Array.isArray(r.data) ? r.data : [];
}
async function patchProfile(token, id, patch) {
  const r = await dataApi(`/profiles?id=eq.${enc(id)}`, token, {
    method: "PATCH", headers: { Prefer: "return=representation" }, body: JSON.stringify(patch)
  });
  if (!r.response.ok) throw new Error(r.data?.message || r.data?.details || "Profile update was rejected.");
  return Array.isArray(r.data) ? r.data[0] || null : r.data;
}
async function loadAssignments(token, path) {
  const r = await dataApi(path, token);
  if (!r.response.ok) throw new Error("Unable to load assignment records.");
  return Array.isArray(r.data) ? r.data : [];
}
export default {
  async fetch(request) {
    const origin = request.headers.get("origin") || "";
    const headers = corsHeaders(origin);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/") return json({ ok: true, service: "savannahapi", stage: "neon-staging", version: 3 }, 200, headers);
    if (request.method !== "POST") return json({ error: "Method not allowed." }, 405, headers);
    const match = (request.headers.get("authorization") || "").match(/^Bearer\s+(.+)$/i);
    if (!match) return json({ error: "Sign in is required." }, 401, headers);
    const token = match[1].trim();
    try {
      const claims = decodeClaims(token);
      if (typeof claims.sub !== "string" || !uuidPattern.test(claims.sub)) return json({ error: "The session token is invalid." }, 401, headers);
      // The Neon Data API validates this bearer token and enforces RLS on each operation.
      const caller = await getProfile(token, claims.sub);
      if (url.pathname === "/profile/ensure") {
        if (caller) return json({ success: true, profile: caller, created: false }, 200, headers);
        const body = await request.json().catch(() => ({}));
        const fullName = typeof body.full_name === "string" ? body.full_name.trim().slice(0, 120) : "";
        const email = typeof claims.email === "string" ? claims.email.trim().toLowerCase().slice(0, 254) : null;
        const inserted = await dataApi("/profiles", token, {
          method: "POST", headers: { Prefer: "return=representation" },
          body: JSON.stringify({ id: claims.sub, email, full_name: fullName || null, role: "client" })
        });
        if (!inserted.response.ok) {
          if (inserted.response.status === 409) {
            const retry = await getProfile(token, claims.sub);
            if (retry) return json({ success: true, profile: retry, created: false }, 200, headers);
          }
          return json({ error: "Profile could not be created. Confirm the account email is verified and try again.", details: inserted.data }, inserted.response.status, headers);
        }
        return json({ success: true, profile: Array.isArray(inserted.data) ? inserted.data[0] : inserted.data, created: true }, 201, headers);
      }
      if (url.pathname !== "/manage-annotators") return json({ error: "Not found." }, 404, headers);
      if (!caller) return json({ error: "Create your Savannah profile before using this workspace." }, 403, headers);
      const body = await request.json().catch(() => ({}));
      const action = typeof body.action === "string" ? body.action : "list";
      const role = caller.role;
      const reviewerActions = ["list_review_queue", "review_assignment"];
      const teamLeadActions = ["list_team_workload"];
      if (action === "update_status") {
        if (role !== "annotator") return json({ error: "Annotator access is required." }, 403, headers);
      } else if (teamLeadActions.includes(action)) {
        if (role !== "team_lead") return json({ error: "Team lead access is required." }, 403, headers);
      } else if (reviewerActions.includes(action)) {
        if (!["admin", "reviewer"].includes(role)) return json({ error: "Reviewer access is required." }, 403, headers);
      } else if (role !== "admin") {
        return json({ error: "Administrator access is required." }, 403, headers);
      }
      if (action === "list") {
        return json({ success: true, annotators: (await listProfiles(token, "annotator")).map(p => ({ id: p.id, email: p.email || "", full_name: p.full_name || "" })) }, 200, headers);
      }
      if (["promote", "promote_reviewer", "promote_team_lead"].includes(action)) {
        const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
        if (!email || email.length > 254 || !emailPattern.test(email)) return json({ error: "Enter a valid email address for an existing Savannah account." }, 400, headers);
        const all = await listProfiles(token, null);
        const target = all.find(p => (p.email || "").toLowerCase() === email);
        if (!target) return json({ error: "No account was found for that email. Ask the person to create a Savannah account first." }, 404, headers);
        if (target.role === "admin") return json({ error: "An administrator account cannot be converted to another role." }, 409, headers);
        const newRole = action === "promote" ? "annotator" : action === "promote_reviewer" ? "reviewer" : "team_lead";
        await patchProfile(token, target.id, { role: newRole });
        return json({ success: true, [newRole]: { id: target.id, email: target.email || email, full_name: target.full_name || "" }, message: `${newRole.replace("_", " ")} access activated. The user should sign out and sign back in.` }, 200, headers);
      }
      if (action === "list_team_leads") {
        const team_leads = (await listProfiles(token, "team_lead")).map(p => ({ id: p.id, email: p.email || "", full_name: p.full_name || "" }));
        return json({ success: true, team_leads }, 200, headers);
      }
      if (action === "list_team_workload") {
        const assignments = await loadAssignments(token, `/project_assignments?select=id,assignment_status,assigned_at,platform,external_task_reference,annotator_user_id,projects(title,project_code,service_type,description,annotation_tool,annotation_workspace_url,tool_access_mode,external_tool_name,due_date)&team_lead_user_id=eq.${enc(claims.sub)}&order=assigned_at.desc`);
        const profiles = await listProfiles(token, null);
        const byId = new Map(profiles.map(p => [p.id, { email: p.email || "", full_name: p.full_name || "" }]));
        const enriched = assignments.map(a => ({ ...a, annotator: byId.get(a.annotator_user_id) || { email: "", full_name: "" } }));
        const counts = { total: enriched.length, assigned: 0, accepted: 0, in_progress: 0, submitted: 0, review: 0, approved: 0, rework: 0 };
        const active = new Set();
        for (const a of enriched) { if (Object.hasOwn(counts, a.assignment_status)) counts[a.assignment_status]++; if (["assigned", "accepted", "in_progress", "rework"].includes(a.assignment_status)) active.add(a.annotator_user_id); }
        counts.active_annotators = active.size;
        return json({ success: true, assignments: enriched, counts, active_annotator_ids: [...active] }, 200, headers);
      }
      if (action === "list_review_queue") {
        const assignments = await loadAssignments(token, "/project_assignments?select=id,annotator_user_id,assignment_status,assigned_at,platform,external_task_reference,projects(title,project_code,service_type,annotation_tool,annotation_workspace_url,tool_access_mode,external_tool_name)&assignment_status=in.(submitted,review)&order=assigned_at.desc");
        const profiles = await listProfiles(token, null);
        const byId = new Map(profiles.map(p => [p.id, { email: p.email || "", full_name: p.full_name || "" }]));
        return json({ success: true, assignments: assignments.map(a => ({ ...a, annotator: byId.get(a.annotator_user_id) || { email: "", full_name: "" } })) }, 200, headers);
      }
      if (action === "review_assignment") {
        const assignmentId = typeof body.assignment_id === "string" ? body.assignment_id : "";
        const nextStatus = typeof body.assignment_status === "string" ? body.assignment_status : "";
        if (!uuidPattern.test(assignmentId)) return json({ error: "A valid assignment ID is required." }, 400, headers);
        if (!["approved", "rework"].includes(nextStatus)) return json({ error: "Choose approve or request rework." }, 400, headers);
        const current = await loadAssignments(token, `/project_assignments?select=id,assignment_status&id=eq.${enc(assignmentId)}&limit=1`);
        if (!current.length || !["submitted", "review"].includes(current[0].assignment_status)) return json({ error: "This assignment is not awaiting review." }, 409, headers);
        const updated = await dataApi(`/project_assignments?id=eq.${enc(assignmentId)}`, token, { method: "PATCH", headers: { Prefer: "return=representation" }, body: JSON.stringify({ assignment_status: nextStatus }) });
        if (!updated.response.ok) return json({ error: "Unable to update the assignment review status.", details: updated.data }, updated.response.status, headers);
        return json({ success: true, assignment: Array.isArray(updated.data) ? updated.data[0] : updated.data, message: nextStatus === "approved" ? "Assignment approved." : "Rework requested." }, 200, headers);
      }
      if (action === "update_status") {
        const assignmentId = typeof body.assignment_id === "string" ? body.assignment_id : "";
        const nextStatus = typeof body.assignment_status === "string" ? body.assignment_status : "";
        if (!uuidPattern.test(assignmentId)) return json({ error: "A valid assignment ID is required." }, 400, headers);
        const current = await loadAssignments(token, `/project_assignments?select=id,annotator_user_id,assignment_status&id=eq.${enc(assignmentId)}&limit=1`);
        if (!current.length || current[0].annotator_user_id !== claims.sub) return json({ error: "This assignment is not available to your account." }, 404, headers);
        const allowed = { assigned: ["accepted"], accepted: ["in_progress"], in_progress: [], rework: [] };
        if (!(allowed[current[0].assignment_status] || []).includes(nextStatus)) return json({ error: "That status change is not allowed. Follow the assignment steps in order." }, 409, headers);
        const updated = await dataApi(`/project_assignments?id=eq.${enc(assignmentId)}`, token, { method: "PATCH", headers: { Prefer: "return=representation" }, body: JSON.stringify({ assignment_status: nextStatus }) });
        if (!updated.response.ok) return json({ error: "Unable to update the assignment status.", details: updated.data }, updated.response.status, headers);
        return json({ success: true, assignment: Array.isArray(updated.data) ? updated.data[0] : updated.data }, 200, headers);
      }
      return json({ error: "Unsupported action." }, 400, headers);
    } catch (error) {
      console.error("savannahapi request failed", error);
      return json({ error: error?.message || "Unable to complete the Savannah request." }, 500, headers);
    }
  }
};