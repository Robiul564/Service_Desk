import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

function getCorsHeaders(request: Request) {
  const allowed = Deno.env.get("ALLOWED_ORIGIN") || "*";
  const origin = request.headers.get("Origin") || "*";
  const allowOrigin = allowed === "*" ? origin : (origin === allowed ? origin : allowed);
  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS"
  };
}

Deno.serve(async request => {
  const corsHeaders = getCorsHeaders(request);
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "POST") return Response.json({ error: "Method not allowed" }, { status: 405, headers: corsHeaders });

  const url = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !anonKey || !serviceKey) return Response.json({ error: "Server is missing Supabase configuration." }, { status: 500, headers: corsHeaders });

  const authorization = request.headers.get("Authorization");
  if (!authorization?.startsWith("Bearer ")) return Response.json({ error: "Sign in as an administrator." }, { status: 401, headers: corsHeaders });

  const callerClient = createClient(url, anonKey, { global: { headers: { Authorization: authorization } } });
  const adminClient = createClient(url, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data: userResult, error: authError } = await callerClient.auth.getUser();
  if (authError || !userResult.user) return Response.json({ error: "The login session is invalid or expired." }, { status: 401, headers: corsHeaders });
  const { data: profile, error: profileError } = await adminClient.from("user_profiles").select("role,enabled").eq("id", userResult.user.id).maybeSingle();
  if (profileError || !profile?.enabled || profile.role !== "admin") return Response.json({ error: "Administrator access is required." }, { status: 403, headers: corsHeaders });

  let body: { action?: string; email?: string; password?: string; role?: string };
  try { body = await request.json(); } catch { return Response.json({ error: "Request body must be JSON." }, { status: 400, headers: corsHeaders }); }
  if (body.action !== "create" || !body.email || !body.password || !["admin", "staff", "viewer"].includes(body.role || "")) {
    return Response.json({ error: "Provide an email, password, and valid role." }, { status: 400, headers: corsHeaders });
  }
  if (body.password.length < 8) return Response.json({ error: "Temporary password must be at least 8 characters." }, { status: 400, headers: corsHeaders });

  const { data: created, error: createError } = await adminClient.auth.admin.createUser({
    email: body.email.trim().toLowerCase(),
    password: body.password,
    email_confirm: true
  });
  if (createError || !created.user) return Response.json({ error: createError?.message || "Could not create account." }, { status: 400, headers: corsHeaders });
  const { data: newProfile, error: updateError } = await adminClient.from("user_profiles")
    .update({ email: body.email.trim().toLowerCase(), role: body.role, enabled: true })
    .eq("id", created.user.id).select("*").single();
  if (updateError) {
    return Response.json({ error: `The account exists but its role could not be saved: ${updateError.message}. Assign its role in the Supabase SQL Editor.` }, { status: 500, headers: corsHeaders });
  }
  return Response.json({ profile: newProfile }, { headers: corsHeaders });
});
