// ============================================================
// LifeOS Daily Digest — Supabase Edge Function
// Runs daily via cron to generate an AI-powered daily briefing
// Deploy: supabase functions deploy daily-digest
// Schedule: supabase functions set-schedule daily-digest --cron "0 6 * * *"
// ============================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import Anthropic from "https://esm.sh/@anthropic-ai/sdk";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const anthropicKey = Deno.env.get("ANTHROPIC_API_KEY")!;

    const supabase = createClient(supabaseUrl, supabaseKey);
    const anthropic = new Anthropic({ apiKey: anthropicKey });

    // Get all users
    const { data: { users } } = await supabase.auth.admin.listUsers();

    for (const user of users || []) {
      const userId = user.id;

      // Fetch user's data
      const [
        { data: tasks },
        { data: habits },
        { data: obligations },
        { data: events },
        { data: expenses },
        { data: journal },
        { data: trackers },
      ] = await Promise.all([
        supabase.from("tasks").select("*").eq("user_id", userId).neq("status", "done"),
        supabase.from("habits").select("*, habit_checkins(*)").eq("user_id", userId),
        supabase.from("obligations").select("*").eq("user_id", userId),
        supabase.from("events").select("*").eq("user_id", userId),
        supabase.from("expenses").select("*").eq("user_id", userId).order("created_at", { ascending: false }).limit(20),
        supabase.from("journal_entries").select("*").eq("user_id", userId).order("created_at", { ascending: false }).limit(7),
        supabase.from("trackers").select("*, tracker_entries(*)").eq("user_id", userId),
      ]);

      const today = new Date().toISOString().slice(0, 10);
      const weekFromNow = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);

      const context = [
        `Today: ${today}`,
        `Active tasks: ${(tasks || []).map(t => `${t.title}${t.due_date ? ` (due: ${t.due_date})` : ""}`).join(", ") || "none"}`,
        `Overdue tasks: ${(tasks || []).filter(t => t.due_date && t.due_date < today).map(t => t.title).join(", ") || "none"}`,
        `Habits: ${(habits || []).map(h => `${h.name} (streak: ${h.current_streak}d)`).join(", ") || "none"}`,
        `Bills due this week: ${(obligations || []).filter(o => o.next_due_date >= today && o.next_due_date <= weekFromNow).map(o => `${o.name}: $${o.amount} (${o.next_due_date})`).join(", ") || "none"}`,
        `Today's events: ${(events || []).filter(e => e.date === today).map(e => `${e.title}${e.time ? ` at ${e.time}` : ""}`).join(", ") || "none"}`,
        `This week's spending: $${(expenses || []).filter(e => e.date >= new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10)).reduce((s, e) => s + Number(e.amount), 0).toFixed(2)}`,
        `Recent mood: ${(journal || []).slice(0, 3).map(j => j.mood).join(", ") || "no entries"}`,
      ].join("\n");

      const response = await anthropic.messages.create({
        model: "claude-sonnet-4-5-20241022",
        max_tokens: 500,
        messages: [{
          role: "user",
          content: `You are LifeOS, a personal life management AI. Generate a concise daily briefing based on this data:\n\n${context}\n\nFormat: Start with a greeting, then cover: 1) Priority tasks, 2) Schedule, 3) Financial alerts, 4) Health/habits check, 5) One motivational note. Keep it under 200 words.`,
        }],
      });

      const digestText = response.content[0].type === "text" ? response.content[0].text : "";

      // Store the digest
      await supabase.from("preferences").upsert({
        user_id: userId,
        key: "ai_digest",
        value: JSON.stringify({
          content: digestText,
          generatedAt: new Date().toISOString(),
          dataSnapshot: { tasks: tasks?.length, habits: habits?.length },
        }),
      }, { onConflict: "user_id,key" });
    }

    return new Response(JSON.stringify({ success: true, usersProcessed: users?.length || 0 }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
