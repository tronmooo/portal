// ============================================================
// LifeOS Auto-Categorize — Supabase Edge Function
// Triggered via webhook when a new expense is created
// Automatically categorizes expenses using AI
// Deploy: supabase functions deploy auto-categorize
// ============================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const CATEGORY_KEYWORDS: Record<string, string[]> = {
  food: ["grocery", "restaurant", "cafe", "coffee", "lunch", "dinner", "breakfast", "pizza", "sushi", "uber eats", "doordash", "grubhub", "starbucks", "chipotle", "mcdonalds", "food"],
  transport: ["gas", "fuel", "uber", "lyft", "parking", "toll", "car wash", "oil change", "tire", "bus", "metro", "transit"],
  health: ["pharmacy", "doctor", "dentist", "gym", "fitness", "medicine", "prescription", "hospital", "therapy", "vitamin", "supplement"],
  entertainment: ["movie", "netflix", "spotify", "game", "concert", "theater", "museum", "bar", "club", "subscription"],
  shopping: ["amazon", "target", "walmart", "costco", "clothing", "shoes", "electronics", "furniture"],
  utilities: ["electric", "water", "internet", "phone", "cable", "utility", "power", "gas bill", "sewage"],
  housing: ["rent", "mortgage", "hoa", "property tax", "home insurance", "repair", "maintenance"],
  pet: ["vet", "pet food", "grooming", "pet store", "boarding", "dog", "cat"],
  education: ["tuition", "books", "course", "class", "training", "certification", "school"],
};

function categorizeByKeywords(description: string): string {
  const lower = description.toLowerCase();
  for (const [category, keywords] of Object.entries(CATEGORY_KEYWORDS)) {
    if (keywords.some(kw => lower.includes(kw))) {
      return category;
    }
  }
  return "general";
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    const body = await req.json();
    const { expense_id, user_id } = body;

    if (!expense_id || !user_id) {
      return new Response(JSON.stringify({ error: "expense_id and user_id required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Fetch the expense
    const { data: expense, error } = await supabase
      .from("expenses")
      .select("*")
      .eq("id", expense_id)
      .eq("user_id", user_id)
      .single();

    if (error || !expense) {
      return new Response(JSON.stringify({ error: "Expense not found" }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Skip if already categorized (not "general")
    if (expense.category && expense.category !== "general") {
      return new Response(JSON.stringify({ skipped: true, category: expense.category }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Categorize using keyword matching
    const category = categorizeByKeywords(expense.description + " " + (expense.vendor || ""));

    if (category !== "general") {
      await supabase
        .from("expenses")
        .update({ category })
        .eq("id", expense_id)
        .eq("user_id", user_id);
    }

    return new Response(JSON.stringify({
      success: true,
      expense_id,
      previous_category: expense.category,
      new_category: category,
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
