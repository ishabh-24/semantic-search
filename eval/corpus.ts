// Labeled evaluation set. A small, self-contained corpus (so the eval is
// reproducible via one script with no Drive access) chosen to exercise both
// retrieval modes honestly:
//   - exact names / IDs / filenames  → lexical should win
//   - paraphrases / conceptual asks  → semantic should win
// The hybrid fusion is expected to match or beat both across the whole set.

export type EvalDoc = { id: string; name: string; text: string };
export type EvalQuery = { q: string; relevant: string[] };

export const DOCS: EvalDoc[] = [
  {
    id: "invoice-q3",
    name: "invoice_2024_Q3_final",
    text: `# Invoice 2024 Q3

## Amounts due
Outstanding balances owed to us by clients for the third quarter. Net-30
payment terms; several accounts are past due and should be chased.

## Line items
Consulting retainer, implementation hours, and a support add-on. Totals are
summed before tax.`,
  },
  {
    id: "hiring-plan",
    name: "Q3 Hiring Plan",
    text: `# Hiring Plan

## Headcount
We plan to grow the engineering team with four new roles this quarter, funded
from the approved recruiting budget.

## Process
Structured interview loops, a take-home exercise, and a debrief before any
offer is extended.`,
  },
  {
    id: "onboarding",
    name: "ONBOARDING_checklist",
    text: `# Onboarding Checklist

## First week
How we welcome a new team member: provision accounts, assign a buddy, and walk
through the codebase together.

## Setup
Laptop, VPN, calendar invites for recurring meetings, and access to shared
drives.`,
  },
  {
    id: "rfc-auth",
    name: "RFC-017-auth-redesign",
    text: `# RFC-017: Authentication Redesign

## Motivation
Replace long-lived cookies with short-lived tokens. Handle sign-in, refresh,
and explicit token revocation cleanly.

## Sessions
A session store tracks active devices so a user can log out everywhere at
once.`,
  },
  {
    id: "runbook-oncall",
    name: "Oncall Runbook",
    text: `# Oncall Runbook

## When the site goes down
Steps to take when servers stop responding or error rates spike: check the
dashboard, roll back the latest deploy, and page the on-call engineer.

## Escalation
If the outage lasts more than fifteen minutes, escalate to the incident
commander.`,
  },
  {
    id: "okrs-2024",
    name: "2024 Company OKRs",
    text: `# 2024 Company OKRs

## Objectives
Our yearly goals and the measurable targets that define success this year.

## Key results
Grow active users, improve retention, and reach breakeven on unit economics.`,
  },
  {
    id: "expense-policy",
    name: "Expense Reimbursement Policy",
    text: `# Expense Reimbursement Policy

## Getting paid back
How to claim money back for work-related spending: keep receipts, submit within
thirty days, and stay under the per-category limits.

## Travel
Flights, hotels, and a daily meal allowance are covered with manager approval.`,
  },
  {
    id: "product-roadmap",
    name: "Product Roadmap H2",
    text: `# Product Roadmap H2

## Where we're headed
The sequence of features and milestones planned for the second half of the
year, and how they build on each other.

## Launches
Two major releases, each preceded by a beta with design-partner customers.`,
  },
  {
    id: "security-review",
    name: "Security Review Q3",
    text: `# Security Review Q3

## Findings
Results of the penetration test and how we keep customer data safe: encryption
at rest, least-privilege access, and dependency scanning.

## Remediation
Track each vulnerability to closure with an owner and a due date.`,
  },
  {
    id: "marketing-brief",
    name: "Marketing Campaign Brief",
    text: `# Marketing Campaign Brief

## Reaching new customers
Audience, channels, and messaging for the upcoming campaign to grow awareness
and drive sign-ups.

## Budget
Paid social, content, and a small events line, measured on cost per acquisition.`,
  },
  {
    id: "recipe-lasagna",
    name: "Grandma's Lasagna Recipe",
    text: `# Lasagna

## Ingredients
Pasta sheets, ground beef, tomato sauce, and a creamy béchamel. Serves eight.

## Method
Layer sauce, pasta, and cheese; bake until bubbling and golden.`,
  },
  {
    id: "travel-japan",
    name: "Japan Trip Itinerary",
    text: `# Japan Trip

## Route
Tokyo for three nights, then Kyoto by bullet train, staying in a traditional
ryokan.

## Packing
Rail pass, comfortable shoes, and a pocket wifi rental.`,
  },
  {
    id: "perf-review",
    name: "Performance Review Template",
    text: `# Performance Review

## Giving feedback
A template for writing feedback for your direct reports: strengths, growth
areas, and goals for next cycle.

## Ratings
A shared rubric keeps ratings consistent across managers.`,
  },
  {
    id: "data-schema",
    name: "Database Schema v2",
    text: `# Database Schema v2

## Tables
Users, sessions, and documents, with foreign keys and the indexes that keep
lookups fast.

## Migrations
Each change ships as a reversible migration applied in order.`,
  },
  {
    id: "meeting-sync",
    name: "Weekly Sync 2024-08-12",
    text: `# Weekly Sync

## Updates
Progress since last week, what's blocked, and who needs help unblocking.

## Decisions
We agreed to cut one feature from the release and revisit it next quarter.`,
  },
  {
    id: "vacation-policy",
    name: "Time Off Policy",
    text: `# Time Off Policy

## Taking a break
How paid vacation and sick days work: accrual, how to request days off, and
holiday coverage.

## Parental leave
Details on leave for new parents and how to plan the handover.`,
  },
];

export const QUERIES: EvalQuery[] = [
  // --- Exact names / IDs / filenames (lexical strength) ---
  { q: "invoice_2024_Q3_final", relevant: ["invoice-q3"] },
  { q: "RFC-017", relevant: ["rfc-auth"] },
  { q: "RFC-017 auth redesign", relevant: ["rfc-auth"] },
  { q: "ONBOARDING_checklist", relevant: ["onboarding"] },
  { q: "2024 Company OKRs", relevant: ["okrs-2024"] },
  { q: "Oncall Runbook", relevant: ["runbook-oncall"] },
  { q: "Database Schema v2", relevant: ["data-schema"] },
  { q: "Weekly Sync 2024-08-12", relevant: ["meeting-sync"] },
  { q: "Product Roadmap H2", relevant: ["product-roadmap"] },
  { q: "Grandma's Lasagna Recipe", relevant: ["recipe-lasagna"] },

  // --- Paraphrase / conceptual (semantic strength) ---
  { q: "money our clients still owe us", relevant: ["invoice-q3"] },
  { q: "how do we welcome new hires", relevant: ["onboarding"] },
  { q: "what to do when the website is down", relevant: ["runbook-oncall"] },
  { q: "logging in and signing out of all devices", relevant: ["rfc-auth"] },
  { q: "keeping customer information private and safe", relevant: ["security-review"] },
  { q: "plan for growing the engineering team", relevant: ["hiring-plan"] },
  { q: "where is the product going next", relevant: ["product-roadmap"] },
  { q: "getting reimbursed for a work trip", relevant: ["expense-policy"] },
  { q: "our trip to Tokyo and Kyoto", relevant: ["travel-japan"] },
  { q: "how to bake an italian pasta bake", relevant: ["recipe-lasagna"] },
  { q: "yearly goals and success metrics", relevant: ["okrs-2024"] },
  { q: "who is blocked this week", relevant: ["meeting-sync"] },
  { q: "database tables and migrations", relevant: ["data-schema"] },
  { q: "writing feedback for my reports", relevant: ["perf-review"] },
  { q: "campaign to reach new customers", relevant: ["marketing-brief"] },
  { q: "how much vacation do I get", relevant: ["vacation-policy"] },
  { q: "requesting days off", relevant: ["vacation-policy"] },
  { q: "responding to an outage", relevant: ["runbook-oncall"] },
  { q: "short-lived tokens instead of cookies", relevant: ["rfc-auth"] },
  { q: "results of the penetration test", relevant: ["security-review"] },
  { q: "interview process for candidates", relevant: ["hiring-plan"] },
  { q: "claiming back travel costs", relevant: ["expense-policy"] },
  { q: "leave for new parents", relevant: ["vacation-policy"] },
  { q: "rolling back a bad deploy", relevant: ["runbook-oncall"] },
  { q: "creamy white sauce for pasta", relevant: ["recipe-lasagna"] },
  { q: "bullet train and a ryokan", relevant: ["travel-japan"] },
  { q: "north star metric and retention", relevant: ["okrs-2024"] },
  { q: "setting up a new laptop and VPN", relevant: ["onboarding"] },
  { q: "cost per acquisition and paid social", relevant: ["marketing-brief"] },
  { q: "reversible schema changes", relevant: ["data-schema"] },

  // --- Mixed / could match term and meaning (hybrid should shine) ---
  { q: "recruiting budget for new roles", relevant: ["hiring-plan"] },
  { q: "past due accounts receivable", relevant: ["invoice-q3"] },
  { q: "performance ratings rubric", relevant: ["perf-review"] },
  { q: "beta release with design partners", relevant: ["product-roadmap"] },
  { q: "encryption at rest for user data", relevant: ["security-review"] },
  { q: "per diem meal allowance", relevant: ["expense-policy"] },
  { q: "incident commander escalation", relevant: ["runbook-oncall"] },
  { q: "token revocation and sessions", relevant: ["rfc-auth"] },
];
