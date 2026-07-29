# Stiki PDA Lead Sourcing Workflow Spec

## Overview

Two modes for sourcing leads into Stiki, toggled via pill at top of PDA app.

---

## Mode 1: LinkedIn Scanner (AI-Sourced)

### Input Criteria
- Location (e.g., "London, UK")
- Industry (e.g., "Fintech")
- Role (e.g., "CTO")

### Flow

```
[Input criteria]
    → [Gimme 10 button]
    → [Claude searches web for matching LinkedIn profiles]
    → [Queue of ~10 profiles displayed]
    → [User processes each one]
```

### Queue Processing (Mobile-First)

For each person in queue:

1. **View**: User taps "View in LinkedIn"
   - Deep link opens LinkedIn app: `linkedin://in/username`
   - User sees full profile in LI app

2. **Decision**: User returns to PDA
   - If interested: They already took a screenshot while in LI
   - PDA shows two options: `[📷 Add Lead]` or `[Skip]`

3. **Add Lead** (if interested):
   - Opens phone camera roll/photo picker
   - User selects the screenshot they took
   - PDA sends to scan endpoint (Claude Vision)
   - Shows extracted info preview:
     - Name
     - Role
     - Company
     - Location
   - User picks board/quadrant (4 colored buttons: 🟡🔵🟢🟣)
   - Confirms → Lead created in Stiki
   - Auto-advances to next person in queue

4. **Skip** (if not interested):
   - Removes from queue
   - Advances to next person

### End State
- Queue is empty
- Stiki has new lead cards on chosen boards
- Each lead has photo, name, role, company extracted

---

## Mode 2: Website/Webhook

### Flow
- User enters a company website URL
- Webhook enriches with company data (via n8n workflow)
- Creates lead card in Stiki
- User chooses board/quadrant color

### Use Case
- Leads from outside LinkedIn (conferences, referrals, cold targets)
- Company-first approach rather than person-first

---

## UI Mockup

```
┌─────────────────────────────────────┐
│ [Scan Mode]  [Web Mode]             │  ← Pill toggle
├─────────────────────────────────────┤
│                                     │
│ Location:  [London, UK           ]  │
│ Industry:  [Fintech              ]  │
│ Role:      [CTO                  ]  │
│                                     │
│         [Gimme 10]                  │
│                                     │
├─────────────────────────────────────┤
│ Queue (7 remaining)                 │
│ ┌─────────────────────────────────┐ │
│ │ 👤 Sarah Jones                  │ │
│ │    CTO @ Monzo                  │ │
│ │    London, UK                   │ │
│ │                                 │ │
│ │ [View in LinkedIn]              │ │
│ │                                 │ │
│ │ [📷 Add Lead]      [Skip]       │ │
│ └─────────────────────────────────┘ │
│                                     │
│ ┌─────────────────────────────────┐ │
│ │ 👤 John Smith                   │ │
│ │    CTO @ Revolut                │ │
│ │    ...                          │ │
│ └─────────────────────────────────┘ │
└─────────────────────────────────────┘
```

### After Photo Selected - Scan Preview

```
┌─────────────────────────────────────┐
│ Scanning...                         │
├─────────────────────────────────────┤
│                                     │
│        ┌──────────────┐             │
│        │    👤        │             │
│        │   Photo      │             │
│        └──────────────┘             │
│                                     │
│  Name:    Sarah Jones               │
│  Role:    CTO                       │
│  Company: Monzo                     │
│  Location: London                   │
│                                     │
│  Add to board:                      │
│  [🟡] [🔵] [🟢] [🟣]                │
│                                     │
│           [Confirm]                 │
│                                     │
└─────────────────────────────────────┘
```

---

## Technical Notes

### Deep Links
- LinkedIn app: `linkedin://in/{username}`
- Falls back to web URL if app not installed

### Scan Endpoint
- Existing worker at `https://levitate-sync.ben-6a6.workers.dev/scan`
- Uses Claude Vision (claude-haiku-4-5) to extract profile info
- Also does web search for company website
- Calls n8n webhook for additional enrichment (phone, email)

### Data Flow
1. PDA app (SvelteKit) in `/pda` folder
2. Worker handles search + scan
3. Creates lead in Stiki via shared storage/sync

### Board Colors (Quadrants)
- 🟡 Yellow (board-0): `#fef9c3`
- 🔵 Blue (board-1): `#dbeafe`
- 🟢 Green (board-2): `#dcfce7`
- 🟣 Purple (board-3): `#f3e8ff`

---

## End Goal

A Stiki board full of qualified leads that user can:
- Further supplement with additional info (via detail modal)
- Change status/move between boards
- Track outreach cadence
