// ============================================================
// LifeOS Notification Check — Supabase Edge Function
// Runs hourly to check for due dates, streaks at risk, etc.
// Deploy: supabase functions deploy notification-check
// Schedule: supabase functions set-schedule notification-check --cron "0 * * * *"
// ============================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

interface Notification {
  user_id: string;
  type: string;
  title: string;
  body: string;
  entity_type?: string;
  entity_id?: string;
  severity: "info" | "warning" | "urgent";
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    const { data: { users } } = await supabase.auth.admin.listUsers();
    const notifications: Notification[] = [];
    const today = new Date().toISOString().slice(0, 10);
    const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);

    for (const user of users || []) {
      const userId = user.id;

      // Check overdue tasks
      const { data: overdueTasks } = await supabase
        .from("tasks")
        .select("id, title, due_date")
        .eq("user_id", userId)
        .neq("status", "done")
        .lt("due_date", today)
        .not("due_date", "is", null);

      for (const task of overdueTasks || []) {
        notifications.push({
          user_id: userId,
          type: "task_overdue",
          title: "Overdue task",
          body: `"${task.title}" was due ${task.due_date}`,
          entity_type: "task",
          entity_id: task.id,
          severity: "warning",
        });
      }

      // Check tasks due today
      const { data: todayTasks } = await supabase
        .from("tasks")
        .select("id, title")
        .eq("user_id", userId)
        .neq("status", "done")
        .eq("due_date", today);

      for (const task of todayTasks || []) {
        notifications.push({
          user_id: userId,
          type: "task_due_today",
          title: "Task due today",
          body: `"${task.title}" is due today`,
          entity_type: "task",
          entity_id: task.id,
          severity: "info",
        });
      }

      // Check obligations due in next 3 days
      const threeDaysOut = new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10);
      const { data: dueBills } = await supabase
        .from("obligations")
        .select("id, name, amount, next_due_date")
        .eq("user_id", userId)
        .gte("next_due_date", today)
        .lte("next_due_date", threeDaysOut);

      for (const bill of dueBills || []) {
        const daysUntil = Math.ceil((new Date(bill.next_due_date).getTime() - Date.now()) / 86400000);
        notifications.push({
          user_id: userId,
          type: "bill_due_soon",
          title: daysUntil === 0 ? "Bill due today" : `Bill due in ${daysUntil} day${daysUntil > 1 ? "s" : ""}`,
          body: `${bill.name}: $${bill.amount}`,
          entity_type: "obligation",
          entity_id: bill.id,
          severity: daysUntil === 0 ? "urgent" : "warning",
        });
      }

      // Check habit streaks at risk (not checked in today for daily habits)
      const { data: habits } = await supabase
        .from("habits")
        .select("id, name, current_streak, frequency")
        .eq("user_id", userId)
        .eq("frequency", "daily")
        .gt("current_streak", 2);

      for (const habit of habits || []) {
        const { data: todayCheckin } = await supabase
          .from("habit_checkins")
          .select("id")
          .eq("habit_id", habit.id)
          .eq("date", today)
          .limit(1);

        if (!todayCheckin || todayCheckin.length === 0) {
          notifications.push({
            user_id: userId,
            type: "streak_at_risk",
            title: "Streak at risk!",
            body: `Your ${habit.current_streak}-day ${habit.name} streak will break if you don't check in today`,
            entity_type: "habit",
            entity_id: habit.id,
            severity: habit.current_streak >= 7 ? "urgent" : "warning",
          });
        }
      }

      // Check document expirations (within 30 days)
      const thirtyDaysOut = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
      const { data: documents } = await supabase
        .from("documents")
        .select("id, name, extracted_data")
        .eq("user_id", userId);

      for (const doc of documents || []) {
        const expDate = doc.extracted_data?.expirationDate || doc.extracted_data?.expiration_date;
        if (expDate && expDate >= today && expDate <= thirtyDaysOut) {
          const daysUntil = Math.ceil((new Date(expDate).getTime() - Date.now()) / 86400000);
          notifications.push({
            user_id: userId,
            type: "document_expiring",
            title: "Document expiring soon",
            body: `"${doc.name}" expires in ${daysUntil} days (${expDate})`,
            entity_type: "document",
            entity_id: doc.id,
            severity: daysUntil <= 7 ? "urgent" : "warning",
          });
        }
      }
    }

    // Store notifications in preferences (could be a dedicated notifications table later)
    for (const userId of new Set(notifications.map(n => n.user_id))) {
      const userNotifs = notifications.filter(n => n.user_id === userId);
      await supabase.from("preferences").upsert({
        user_id: userId,
        key: "pending_notifications",
        value: JSON.stringify({
          notifications: userNotifs,
          checkedAt: new Date().toISOString(),
        }),
      }, { onConflict: "user_id,key" });
    }

    return new Response(JSON.stringify({
      success: true,
      notificationsGenerated: notifications.length,
      usersChecked: users?.length || 0,
    }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
