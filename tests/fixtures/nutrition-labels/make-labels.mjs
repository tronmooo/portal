// Renders the nutrition label pictures the live check uploads
// (tests/live-nutrition-engine-check.ts). They are DRAWN, not photographed:
// standard Nutrition Facts panels with known values, one of them tilted and
// blurred to stand in for a hand-held photo. Run: node make-labels.mjs
import { createRequire } from "module";
const { chromium } = createRequire(import.meta.url)("playwright");

const row = (name, amount, dv = "", indent = 0, bold = false) =>
  `<div class="r" style="padding-left:${indent * 14}px"><span>${bold ? `<b>${name}</b>` : name} ${amount}</span><b>${dv}</b></div>`;
const panel = ({ product, servings, serving, calories, rows, foot = "" }) => `
<div class="wrap"><div class="brand">${product}</div>
<div class="nf"><h1>Nutrition Facts</h1>
<div class="sv">${servings}</div><div class="sz"><b>Serving size</b><b>${serving}</b></div>
<div class="thick"></div><div class="small"><b>Amount per serving</b></div>
<div class="cal"><b>Calories</b><b>${calories}</b></div><div class="mid"></div>
<div class="dv"><b>% Daily Value*</b></div>${rows.join("")}<div class="thick"></div>${foot}
<div class="note">* The % Daily Value (DV) tells you how much a nutrient in a serving of food contributes to a daily diet.</div></div></div>`;

const LABELS = {
  "granola": panel({
    product: "NORTHFIELD OATS · Maple Pecan Granola", servings: "8 servings per container", serving: "2/3 cup (55g)", calories: 230,
    rows: [row("Total Fat", "9g", "12%", 0, true), row("Saturated Fat", "1g", "5%", 1), row("<i>Trans</i> Fat", "0g", "", 1), row("Cholesterol", "0mg", "0%", 0, true),
      row("Sodium", "115mg", "5%", 0, true), row("Total Carbohydrate", "34g", "12%", 0, true), row("Dietary Fiber", "4g", "14%", 1), row("Total Sugars", "10g", "", 1),
      row("Includes 8g Added Sugars", "", "16%", 2), row("Protein", "5g", "", 0, true)],
    foot: row("Vitamin D", "0mcg", "0%") + row("Calcium", "26mg", "2%") + row("Iron", "1.6mg", "8%") + row("Potassium", "150mg", "4%"),
  }),
  "keto-bar": panel({
    product: "SUMMIT · Chocolate Almond Keto Bar", servings: "1 serving per container", serving: "1 bar (60g)", calories: 200,
    rows: [row("Total Fat", "14g", "18%", 0, true), row("Saturated Fat", "6g", "30%", 1), row("<i>Trans</i> Fat", "0g", "", 1), row("Cholesterol", "5mg", "2%", 0, true),
      row("Sodium", "180mg", "8%", 0, true), row("Total Carbohydrate", "22g", "8%", 0, true), row("Dietary Fiber", "9g", "32%", 1), row("Total Sugars", "2g", "", 1),
      row("Includes 1g Added Sugars", "", "2%", 2), row("Sugar Alcohol", "4g", "", 1), row("Allulose", "6g", "", 1), row("Protein", "12g", "", 0, true)],
  }),
  "drink": panel({
    product: "BRIGHTWATER · Citrus Green Tea", servings: "About 2.5 servings per container", serving: "8 fl oz (240mL)", calories: 70,
    rows: [row("Total Fat", "0g", "0%", 0, true), row("Sodium", "15mg", "1%", 0, true), row("Total Carbohydrate", "17g", "6%", 0, true), row("Total Sugars", "16g", "", 1),
      row("Includes 14g Added Sugars", "", "28%", 2), row("Protein", "1g", "", 0, true)],
    foot: row("Vitamin C", "60mg", "70%") + row("Caffeine", "34mg", ""),
  }),
  "chips-dual": `
<div class="wrap"><div class="brand">RIDGELINE · Sea Salt Kettle Chips</div>
<div class="nf"><h1>Nutrition Facts</h1><div class="sv">3 servings per container</div><div class="sz"><b>Serving size</b><b>about 15 chips (28g)</b></div>
<div class="thick"></div><table><tr><th></th><th>Per serving</th><th>Per container</th></tr>
<tr class="big"><td><b>Calories</b></td><td><b>150</b></td><td><b>450</b></td></tr>
<tr><td><b>Total Fat</b></td><td>9g</td><td>27g</td></tr><tr><td>&nbsp;&nbsp;Saturated Fat</td><td>1.5g</td><td>4.5g</td></tr>
<tr><td>&nbsp;&nbsp;<i>Trans</i> Fat</td><td>0g</td><td>0g</td></tr><tr><td><b>Sodium</b></td><td>170mg</td><td>510mg</td></tr>
<tr><td><b>Total Carbohydrate</b></td><td>16g</td><td>48g</td></tr><tr><td>&nbsp;&nbsp;Dietary Fiber</td><td>1g</td><td>3g</td></tr>
<tr><td>&nbsp;&nbsp;Total Sugars</td><td>&lt;1g</td><td>1g</td></tr><tr><td><b>Protein</b></td><td>2g</td><td>6g</td></tr></table>
<div class="thick"></div></div></div>`,
  "barcode": `<div class="wrap" style="width:420px"><div class="brand">Hazelnut spread</div><div class="bars">${
    Array.from({ length: 95 }, (_, i) => `<i style="width:${1 + ((i * 7 + 3) % 4)}px;background:${i % 2 ? "#fff" : "#000"}"></i>`).join("")
  }</div><div class="digits">3 017620 422003</div></div>`,
};
const CSS = `body{margin:0;background:#d9d4cb;font-family:Helvetica,Arial,sans-serif}
.wrap{width:360px;margin:28px;padding:14px;background:#fbfaf6}.brand{font-weight:700;font-size:15px;margin-bottom:8px;letter-spacing:.3px}
.nf{border:2px solid #000;padding:6px 8px;color:#000}.nf h1{font-size:34px;margin:0;line-height:1;border-bottom:1px solid #000;padding-bottom:4px}
.sv{font-size:14px;margin-top:4px}.sz,.cal,.r{display:flex;justify-content:space-between}.sz{font-size:15px}
.thick{border-top:10px solid #000;margin:4px 0}.mid{border-top:5px solid #000;margin:2px 0}.small{font-size:12px}
.cal{font-size:28px;line-height:1.1}.dv{text-align:right;font-size:12px;border-bottom:1px solid #000}
.r{font-size:14px;border-bottom:1px solid #000;padding:2px 0}.note{font-size:10px;margin-top:4px}
table{width:100%;border-collapse:collapse;font-size:14px}td,th{border-bottom:1px solid #000;padding:2px 4px;text-align:right}td:first-child,th:first-child{text-align:left}
tr.big td{font-size:20px}.bars{display:flex;height:120px;align-items:stretch;margin:10px 0 4px}.bars i{display:block}.digits{font-family:monospace;font-size:26px;letter-spacing:3px;text-align:center}`;

const browser = await chromium.launch();
const shot = async (name, html, extraCss = "") => {
  const page = await browser.newPage({ viewport: { width: 520, height: 720 }, deviceScaleFactor: 2 });
  await page.setContent(`<style>${CSS}${extraCss}</style>${html}`);
  await page.locator(".wrap").first().screenshot({ path: `${name}.png` });
  await page.close();
};
for (const [name, html] of Object.entries(LABELS)) await shot(name, html);
// The same granola label as a hand-held photo: tilted, in perspective, slightly out of focus.
{
  const page = await browser.newPage({ viewport: { width: 560, height: 760 }, deviceScaleFactor: 2 });
  await page.setContent(`<style>${CSS}body{background:#8a7f70;perspective:900px}.wrap{transform:rotate(-6deg) rotateY(14deg) rotateX(6deg);filter:blur(.7px) brightness(.93);margin:70px 60px}</style>${LABELS.granola}`);
  await page.screenshot({ path: "granola-photo.png" });
  await page.close();
}
await browser.close();
console.log("labels written");
