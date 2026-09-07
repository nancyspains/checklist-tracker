// Pulls last week's (Mon-Sun) checklist completion data from the Daily
// Checklist Tracker's Supabase database, computes a pooled weekly
// completion % per pub, and writes it into that pub's "tasks" field in
// the KPI Manager's Firestore - without touching any other field (labour,
// gp, mystery, etc. stay exactly as the GM entered them). Runs every
// Tuesday via GitHub Actions; see .github/workflows/sync-tasks.yml.
//
// Both the Supabase and Firebase credentials below are the SAME public,
// client-side keys already embedded in index.html and the KPI dashboard
// pages themselves - there is nothing secret here, so no GitHub Actions
// secrets are needed for this workflow.

import { initializeApp } from "firebase/app";
import { getFirestore, doc, setDoc } from "firebase/firestore";

const SUPABASE_URL = "https://vqfvklqdexakwjjyvwod.supabase.co";
const SUPABASE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZxZnZrbHFkZXhha3dqanl2d29kIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzU3NDAwNjQsImV4cCI6MjA5MTMxNjA2NH0.JETvur4VrrIWPCwK3MbQ4zzmOiX1Tc7F_xFWC2OR93M";

const firebaseConfig = {
  apiKey: "AIzaSyCp4Kb2mh_RC80TE8WcGjLZX2Of4huqt5E",
  authDomain: "nancy-spains-kpi.firebaseapp.com",
  projectId: "nancy-spains-kpi",
  storageBucket: "nancy-spains-kpi.firebasestorage.app",
  messagingSenderId: "1042191730060",
  appId: "1:1042191730060:web:8819d9840616dceb7382a9",
};
const STORE_KEY = "ns_kpi_weeks";

// Site ID -> full KPI pub name (confirmed live via the tracker's own
// config table, 2026-09-07: s1=Shoreditch, s2=Monument, s3=Manchester).
const SITE_TO_PUB = {
  s1: "Nancy Spains Shoreditch",
  s2: "Nancy Spains Monument",
  s3: "Nancy Spains Manchester",
};

// Ported directly from checklist-tracker/index.html so the "total possible"
// count for each day/site matches exactly what the tracker itself uses.
const DAY_CHECKLISTS = {
  1: ["eon", "opening", "closing", "timesheets", "audit", "maintenance"],
  2: ["eon", "opening", "closing", "inventory"],
  3: ["eon", "opening", "closing"],
  4: ["eon", "opening", "closing", "deepclean", "eow"],
  5: ["eon", "opening", "closing", "cellar", "orders"],
  6: ["eon", "opening", "closing"],
  0: ["eon", "opening", "closing"],
};
const SITE_OVERRIDES = {
  s2: {
    1: ["timesheets", "audit", "maintenance"],
    2: ["eon", "opening", "closing", "inventory"],
    3: ["eon", "opening", "closing"],
    4: ["eon", "opening", "closing", "deepclean", "eow"],
    5: ["eon", "opening", "closing", "orders"],
    6: ["eon", "opening", "closing", "cellar"],
    0: ["eon", "opening", "closing"],
  },
};

function getChecklistIds(dateStr, siteId) {
  const dow = new Date(dateStr + "T12:00:00").getDay();
  if (SITE_OVERRIDES[siteId] && SITE_OVERRIDES[siteId][dow]) {
    return SITE_OVERRIDES[siteId][dow];
  }
  return DAY_CHECKLISTS[dow] || [];
}

function fmtDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// Previous complete Mon-Sun week, relative to "now". Robust to whatever
// day this actually runs on (matters for the workflow_dispatch test runs,
// not just the Tuesday schedule).
function previousWeekRange(now = new Date()) {
  const day = now.getDay(); // 0=Sun..6=Sat
  const thisMonday = new Date(now);
  thisMonday.setDate(now.getDate() - ((day + 6) % 7));
  const lastMonday = new Date(thisMonday);
  lastMonday.setDate(thisMonday.getDate() - 7);
  const lastSunday = new Date(lastMonday);
  lastSunday.setDate(lastMonday.getDate() + 6);
  const dates = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(lastMonday);
    d.setDate(lastMonday.getDate() + i);
    dates.push(fmtDate(d));
  }
  return { monday: fmtDate(lastMonday), sunday: fmtDate(lastSunday), dates };
}

async function fetchCompletions(monday, sunday) {
  const url = `${SUPABASE_URL}/rest/v1/completions?completion_date=gte.${monday}&completion_date=lte.${sunday}&select=site_id,check_id,completion_date,completed`;
  const resp = await fetch(url, {
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
  });
  if (!resp.ok) throw new Error(`Supabase fetch failed: ${resp.status} ${await resp.text()}`);
  return resp.json();
}

async function main() {
  const { monday, sunday, dates } = previousWeekRange();
  console.log(`[info] Computing task completion for week ${monday} to ${sunday}`);

  const rows = await fetchCompletions(monday, sunday);
  console.log(`[info] Fetched ${rows.length} completion rows from Supabase`);

  const app = initializeApp(firebaseConfig);
  const db = getFirestore(app);

  for (const [siteId, pubName] of Object.entries(SITE_TO_PUB)) {
    let totalPossible = 0;
    const scheduledSet = new Set(); // "date|checkId" pairs actually scheduled, for correct filtering
    for (const date of dates) {
      const ids = getChecklistIds(date, siteId);
      totalPossible += ids.length;
      ids.forEach((id) => scheduledSet.add(`${date}|${id}`));
    }

    const completedCount = rows.filter(
      (r) => r.site_id === siteId && r.completed && scheduledSet.has(`${r.completion_date}|${r.check_id}`)
    ).length;

    const pct = totalPossible > 0 ? Math.round((completedCount / totalPossible) * 100) : 0;

    console.log(`[info] ${pubName}: ${completedCount}/${totalPossible} = ${pct}%`);

    // Merge-safe write: only ever touches this pub's "tasks" field within
    // the week's document. Confirmed via a live test (2026-09-07) that
    // Firestore's setDoc(..., {merge:true}) recursively merges nested
    // objects, so labour/gp/mystery/etc. already entered by the GM for
    // this week are left completely untouched.
    await setDoc(doc(db, STORE_KEY, sunday), { [pubName]: { tasks: pct } }, { merge: true });
    console.log(`[info] Wrote tasks=${pct} for ${pubName} into week ${sunday}`);
  }

  console.log("[info] Done.");
}

main().catch((e) => {
  console.error("[error]", e);
  process.exit(1);
});
