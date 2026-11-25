// Word's template library (owner request 2026-11-25: "Résumés, letters,
// reports, business plans, contracts and personal documents").
//
// A template is a STRUCTURE: headings and the wording that is the same for
// everyone. Every place a personal fact belongs is a `[Missing: …]` blank —
// the same marker the AI Writer uses (W6) — so a template never carries an
// example name, address or figure that could be mistaken for the writer's
// own, and the editor's blank counter and AI Review both find what is left
// to fill in. "Fill in with AI" hands the template to the Document AI, which
// fills a blank only from what is on file.
//
// HTML here uses only the tags the editor holds (shared/page-setup.ts).
//
// Pure. Pinned by tests/doc-templates.test.ts.

export type DocTemplateGroup = "resume" | "letter" | "report" | "business" | "contract" | "personal";
export const DOC_TEMPLATE_GROUPS: Array<{ id: DocTemplateGroup; label: string }> = [
  { id: "resume", label: "Résumés" },
  { id: "letter", label: "Letters" },
  { id: "report", label: "Reports" },
  { id: "business", label: "Business plans" },
  { id: "contract", label: "Contracts" },
  { id: "personal", label: "Personal" },
];

export interface WordTemplate {
  id: string;
  group: DocTemplateGroup;
  label: string;
  description: string;
  title: string;
  html: string;
  /** Shown with a contract: a template is a starting point, not legal advice. */
  caution?: string;
}

const m = (what: string) => `[Missing: ${what}]`;
const html = (parts: string[]) => parts.join("");
const CONTRACT_CAUTION = "A starting structure, not legal advice. Have an agreement that matters reviewed by a lawyer before anyone signs.";

export const WORD_TEMPLATES: WordTemplate[] = [
  {
    id: "resume-chronological", group: "resume", label: "Résumé", description: "Experience first, newest job at the top.", title: "Résumé",
    html: html([
      `<h1>${m("full name")}</h1>`,
      `<p>${m("city and state")} · ${m("phone number")} · ${m("email address")}</p>`,
      `<h2>Summary</h2><p>${m("two or three sentences on who you are professionally and what you are looking for")}</p>`,
      `<h2>Experience</h2>`,
      `<h3>${m("most recent job title")} — ${m("employer")}</h3><p><em>${m("start date")} to ${m("end date or Present")} · ${m("location")}</em></p>`,
      `<ul><li>${m("an accomplishment, with a number if you have one")}</li><li>${m("a second accomplishment")}</li><li>${m("a third accomplishment")}</li></ul>`,
      `<h3>${m("previous job title")} — ${m("previous employer")}</h3><p><em>${m("start date")} to ${m("end date")} · ${m("location")}</em></p>`,
      `<ul><li>${m("an accomplishment")}</li><li>${m("a second accomplishment")}</li></ul>`,
      `<h2>Education</h2><p><strong>${m("degree or certificate")}</strong>, ${m("school")} — ${m("year completed")}</p>`,
      `<h2>Skills</h2><p>${m("skills, separated by commas")}</p>`,
    ]),
  },
  {
    id: "resume-skills", group: "resume", label: "Skills-first résumé", description: "For a career change or a first job: skills before history.", title: "Résumé",
    html: html([
      `<h1>${m("full name")}</h1>`,
      `<p>${m("city and state")} · ${m("phone number")} · ${m("email address")}</p>`,
      `<h2>Profile</h2><p>${m("what you offer and the kind of role you want")}</p>`,
      `<h2>Key skills</h2>`,
      `<h3>${m("first skill area")}</h3><ul><li>${m("where you used it and what came of it")}</li><li>${m("a second example")}</li></ul>`,
      `<h3>${m("second skill area")}</h3><ul><li>${m("where you used it and what came of it")}</li><li>${m("a second example")}</li></ul>`,
      `<h2>Work history</h2><ul><li>${m("job title, employer, years")}</li><li>${m("job title, employer, years")}</li></ul>`,
      `<h2>Education and training</h2><p>${m("degree, certificate or course, with where and when")}</p>`,
    ]),
  },
  {
    id: "letter-cover", group: "letter", label: "Cover letter", description: "To go with a job application.", title: "Cover Letter",
    html: html([
      `<p>${m("your full name")}<br>${m("your address")}<br>${m("phone number")} · ${m("email address")}</p>`,
      `<p>${m("today's date")}</p>`,
      `<p>${m("hiring manager's name, or Hiring Manager")}<br>${m("company name")}<br>${m("company address")}</p>`,
      `<p>Dear ${m("name, or Hiring Manager")},</p>`,
      `<p>I am writing to apply for the ${m("job title")} position at ${m("company name")}. ${m("one sentence on why this role and this company")}</p>`,
      `<p>${m("a paragraph on the experience that fits the job best, with one concrete result")}</p>`,
      `<p>${m("a paragraph on what you would bring that others might not")}</p>`,
      `<p>I would welcome the chance to talk about how I can contribute. Thank you for your time and consideration.</p>`,
      `<p>Sincerely,<br>${m("your full name")}</p>`,
    ]),
  },
  {
    id: "letter-formal", group: "letter", label: "Formal letter", description: "A request, a notice or a complaint to an organisation.", title: "Letter",
    html: html([
      `<p>${m("your full name")}<br>${m("your address")}</p>`,
      `<p>${m("today's date")}</p>`,
      `<p>${m("recipient's name and title")}<br>${m("organisation")}<br>${m("organisation's address")}</p>`,
      `<p><strong>Re: ${m("what this letter is about, with any account or reference number")}</strong></p>`,
      `<p>Dear ${m("recipient's name, or Sir or Madam")},</p>`,
      `<p>${m("what you are writing about and what you are asking for, in one or two sentences")}</p>`,
      `<p>${m("the facts in order: what happened, when, and what you have already done")}</p>`,
      `<p>${m("what you would like them to do, and by when")}</p>`,
      `<p>I can be reached at ${m("phone number or email address")}. Thank you for your attention to this matter.</p>`,
      `<p>Yours sincerely,<br>${m("your full name")}</p>`,
    ]),
  },
  {
    id: "letter-resignation", group: "letter", label: "Resignation letter", description: "Short and courteous notice to an employer.", title: "Resignation Letter",
    html: html([
      `<p>${m("your full name")}<br>${m("today's date")}</p>`,
      `<p>${m("manager's name")}<br>${m("company name")}</p>`,
      `<p>Dear ${m("manager's name")},</p>`,
      `<p>Please accept this letter as formal notice of my resignation from my position as ${m("your job title")}. My last day of work will be ${m("last working day")}.</p>`,
      `<p>Thank you for the opportunities I have had here. ${m("one specific thing you are grateful for, optional")}</p>`,
      `<p>I will do everything I can to make the handover a smooth one.</p>`,
      `<p>Sincerely,<br>${m("your full name")}</p>`,
    ]),
  },
  {
    id: "report-general", group: "report", label: "Report", description: "Summary, findings and recommendations.", title: "Report",
    html: html([
      `<h1>${m("report title")}</h1>`,
      `<p><strong>Prepared by:</strong> ${m("your name")} · <strong>Date:</strong> ${m("date")} · <strong>For:</strong> ${m("who this report is for")}</p>`,
      `<h2>Summary</h2><p>${m("the main point and the main recommendation, in three or four sentences")}</p>`,
      `<h2>Background</h2><p>${m("why this report was written and what it covers")}</p>`,
      `<h2>Findings</h2>`,
      `<h3>${m("first finding")}</h3><p>${m("what you found and the evidence for it")}</p>`,
      `<h3>${m("second finding")}</h3><p>${m("what you found and the evidence for it")}</p>`,
      `<h2>Recommendations</h2><ol><li>${m("first recommendation")}</li><li>${m("second recommendation")}</li></ol>`,
      `<h2>Next steps</h2><table><thead><tr><th>Action</th><th>Owner</th><th>Due</th></tr></thead><tbody><tr><td>${m("action")}</td><td>${m("owner")}</td><td>${m("due date")}</td></tr></tbody></table>`,
    ]),
  },
  {
    id: "report-status", group: "report", label: "Status update", description: "Where a project stands this week or month.", title: "Status Update",
    html: html([
      `<h1>${m("project name")} — status update</h1>`,
      `<p><strong>Period:</strong> ${m("the dates this covers")} · <strong>Overall:</strong> ${m("on track, at risk or behind")}</p>`,
      `<h2>Done since the last update</h2><ul><li>${m("something finished")}</li><li>${m("something finished")}</li></ul>`,
      `<h2>In progress</h2><ul><li>${m("what is being worked on, and by whom")}</li></ul>`,
      `<h2>Risks and blockers</h2><ul><li>${m("what could slow this down, and what is needed")}</li></ul>`,
      `<h2>Next</h2><ul><li>${m("what happens before the next update")}</li></ul>`,
    ]),
  },
  {
    id: "business-plan", group: "business", label: "Business plan", description: "The full plan: market, operations and money.", title: "Business Plan",
    html: html([
      `<h1>${m("business name")}</h1><p><em>Business plan · ${m("date")}</em></p>`,
      `<h2>Executive summary</h2><p>${m("what the business does, for whom, and why it will work — written last, kept to one paragraph")}</p>`,
      `<h2>The problem and the solution</h2><p>${m("the problem customers have today")}</p><p>${m("what you offer and why it is better")}</p>`,
      `<h2>Market</h2><p>${m("who the customers are and how many there are")}</p><p>${m("the main competitors and how you differ")}</p>`,
      `<h2>Products and pricing</h2><p>${m("what you sell and what you charge")}</p>`,
      `<h2>Marketing and sales</h2><p>${m("how customers will find you and how a sale happens")}</p>`,
      `<h2>Operations</h2><p>${m("where and how the work gets done, and what it depends on")}</p>`,
      `<h2>Team</h2><p>${m("who is involved and what each person does")}</p>`,
      `<h2>Financial plan</h2><table><thead><tr><th></th><th>Year 1</th><th>Year 2</th><th>Year 3</th></tr></thead><tbody>` +
        `<tr><td>Revenue</td><td>${m("year 1 revenue")}</td><td>${m("year 2 revenue")}</td><td>${m("year 3 revenue")}</td></tr>` +
        `<tr><td>Costs</td><td>${m("year 1 costs")}</td><td>${m("year 2 costs")}</td><td>${m("year 3 costs")}</td></tr>` +
        `<tr><td>Profit</td><td>${m("year 1 profit")}</td><td>${m("year 2 profit")}</td><td>${m("year 3 profit")}</td></tr></tbody></table>`,
      `<h2>Funding</h2><p>${m("how much is needed, what it is for, and where it will come from")}</p>`,
    ]),
  },
  {
    id: "business-one-page", group: "business", label: "One-page plan", description: "The whole idea on a single page.", title: "One-Page Business Plan",
    html: html([
      `<h1>${m("business name")}</h1>`,
      `<p><strong>What we do:</strong> ${m("one sentence")}</p>`,
      `<p><strong>Who it is for:</strong> ${m("the customer")}</p>`,
      `<p><strong>Why us:</strong> ${m("what makes this better or different")}</p>`,
      `<p><strong>How we make money:</strong> ${m("pricing and main sources of revenue")}</p>`,
      `<p><strong>How customers find us:</strong> ${m("main marketing channels")}</p>`,
      `<p><strong>What it costs to run:</strong> ${m("main costs")}</p>`,
      `<p><strong>Goals for the next 12 months:</strong></p><ol><li>${m("first goal")}</li><li>${m("second goal")}</li><li>${m("third goal")}</li></ol>`,
    ]),
  },
  {
    id: "contract-services", group: "contract", label: "Service agreement", description: "Work done by one party for another, and what is paid for it.", title: "Service Agreement", caution: CONTRACT_CAUTION,
    html: html([
      `<h1>Service Agreement</h1>`,
      `<p>This agreement is made on ${m("date")} between ${m("client's full name or company")} ("the Client") of ${m("client's address")} and ${m("provider's full name or company")} ("the Provider") of ${m("provider's address")}.</p>`,
      `<h2>1. Services</h2><p>The Provider will ${m("describe the work to be done")}.</p>`,
      `<h2>2. Term</h2><p>The work begins on ${m("start date")} and ${m("ends on a date, or continues until ended under clause 6")}.</p>`,
      `<h2>3. Payment</h2><p>The Client will pay ${m("amount and whether per hour, per month or for the whole job")}. Invoices are due within ${m("number of days")} days.</p>`,
      `<h2>4. Expenses</h2><p>${m("which expenses the Client covers, or that none are covered")}</p>`,
      `<h2>5. Confidentiality</h2><p>Each party will keep the other's confidential information private and use it only for this agreement.</p>`,
      `<h2>6. Ending this agreement</h2><p>Either party may end this agreement by giving ${m("number of days")} days' written notice. Work done up to the end date will be paid for.</p>`,
      `<h2>7. Governing law</h2><p>This agreement is governed by the laws of ${m("state or country")}.</p>`,
      `<h2>Signatures</h2><table><tbody><tr><td>Client: ${m("client's name")}<br><br>Signature: ____________________<br>Date: ____________</td><td>Provider: ${m("provider's name")}<br><br>Signature: ____________________<br>Date: ____________</td></tr></tbody></table>`,
    ]),
  },
  {
    id: "contract-simple", group: "contract", label: "Simple agreement", description: "Two parties, what each will do, and when.", title: "Agreement", caution: CONTRACT_CAUTION,
    html: html([
      `<h1>Agreement</h1>`,
      `<p>Made on ${m("date")} between ${m("first party's full name")} and ${m("second party's full name")}.</p>`,
      `<h2>What is agreed</h2><ol><li>${m("first party")} will ${m("what the first party will do, and by when")}.</li><li>${m("second party")} will ${m("what the second party will do, and by when")}.</li></ol>`,
      `<h2>Payment</h2><p>${m("the amount, who pays whom, and when — or that no money changes hands")}</p>`,
      `<h2>If something changes</h2><p>Any change to this agreement must be in writing and signed by both parties.</p>`,
      `<h2>Signatures</h2><p>${m("first party's name")}: ____________________ Date: ____________</p><p>${m("second party's name")}: ____________________ Date: ____________</p>`,
    ]),
  },
  {
    id: "personal-statement", group: "personal", label: "Personal statement", description: "For a school, programme or scholarship application.", title: "Personal Statement",
    html: html([
      `<h1>Personal Statement</h1><p><em>${m("your full name")} · ${m("what you are applying for")}</em></p>`,
      `<p>${m("an opening that shows who you are through one specific moment or experience")}</p>`,
      `<p>${m("what you have done that prepared you for this, with examples")}</p>`,
      `<p>${m("why this programme or opportunity in particular")}</p>`,
      `<p>${m("what you hope to do with it, and what you will contribute")}</p>`,
    ]),
  },
  {
    id: "personal-reference", group: "personal", label: "Reference letter", description: "Recommending someone you know.", title: "Letter of Reference",
    html: html([
      `<p>${m("your full name")}<br>${m("your title or relationship to the person")}<br>${m("phone number or email address")}</p>`,
      `<p>${m("today's date")}</p>`,
      `<p>To whom it may concern,</p>`,
      `<p>I am writing to recommend ${m("the person's full name")}, whom I have known for ${m("how long")} as ${m("how you know them")}.</p>`,
      `<p>${m("what they are good at, with one specific example you saw yourself")}</p>`,
      `<p>${m("a second quality, with an example")}</p>`,
      `<p>I recommend ${m("the person's first name")} without reservation and am happy to say more if it would help.</p>`,
      `<p>Sincerely,<br>${m("your full name")}</p>`,
    ]),
  },
  {
    id: "personal-meeting-notes", group: "personal", label: "Meeting notes", description: "Who was there, what was decided, who does what.", title: "Meeting Notes",
    html: html([
      `<h1>${m("meeting subject")}</h1><p><strong>Date:</strong> ${m("date")} · <strong>Present:</strong> ${m("who attended")}</p>`,
      `<h2>Discussed</h2><ul><li>${m("a topic and what was said")}</li><li>${m("a topic and what was said")}</li></ul>`,
      `<h2>Decided</h2><ul><li>${m("a decision")}</li></ul>`,
      `<h2>Actions</h2><table><thead><tr><th>Action</th><th>Who</th><th>By when</th></tr></thead><tbody><tr><td>${m("action")}</td><td>${m("who")}</td><td>${m("date")}</td></tr></tbody></table>`,
    ]),
  },
];

export function wordTemplate(id: string | null | undefined): WordTemplate | null {
  return WORD_TEMPLATES.find((t) => t.id === id) ?? null;
}
export function wordTemplatesIn(group: DocTemplateGroup): WordTemplate[] {
  return WORD_TEMPLATES.filter((t) => t.group === group);
}
