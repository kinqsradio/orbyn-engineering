# UI parity audit

Reference: running T3 Code, observed look-only at 1728x1048, plus its source at
`cadf7d5fe3` and two saved captures. The candidate is `web/` on mock data unless a
row says otherwise. Live inspection stopped early, when script access to the
reference was declined, so most states below are source-derived or unobserved.
"Live" means measured in the running app. Nothing from the reference's data is here.

| Surface | State | Reference observed | Our status | Measured deviation |
| --- | --- | --- | --- | --- |
| Sidebar | Width | Live: 208px | Match | 0 |
| Sidebar | Search row | Live: y 62-90, icon buttons 28px | Match | 0, y from CSS, not re-measured |
| Sidebar | Settled row | Live: one line, 36px, pitch 37, 14px title, 12px age | Match | Not re-measured after change |
| Sidebar | Settled shelf | Live: toggle 32px, 10 rows, then Show n more | Match | 0 |
| Sidebar | Footer | Live: 32px buttons at x 8, 44, 80; update at x 167 | Match | Update x 166 at 1728 |
| Sidebar | Main list rows | Marketing image only; live list was empty | Three-line rows | Unobserved live |
| Sidebar | Traffic-light clearance | Saved capture | Not built; shell has a native title bar | Gap |
| Sidebar | Drag resize and label reveal | Source only | Not built | Gap |
| Hover card | Older thread | Live: x row right + 4, width 320, radius 6, 150ms scale and opacity; delay per source 150ms | Built with neutral rows | Live height 109, ours varies |
| Draft | Heading | Live: 30px, -0.75px, line 36 | Match | Tracking -0.75px, x differs by column |
| Draft | Composer | Live: 736x111.5; capture x 80-816, y 469-580 | x 80.5-816.5, y 468-580 | 0.5 x, 1 y |
| Draft | Divider and pane | Capture: x 1189, pane 539 | x 1189, 539 | 0 |
| Draft | Details card | Capture: 280 wide, y 64-295 | 280, y 64-225 | Shorter: editor, script and commit rows hidden |
| Draft | Launcher | Capture: seven surfaces | Terminal, Diff, Activity | Others hidden, no backend |
| Timeline | Markdown body | Live: 14px, line 22.75, p margin 10.4 | Match | Line height from 1.625 |
| Timeline | Heading h2 | Live: 18px, 600, margins 20 and 8 | Match | 0 |
| Timeline | Inline code | Live: 11.9px, radius 4, padding 1.19/4.165 | Match | 0 by ratio |
| Timeline | User bubble | Live: radius 16, padding 12 | Match | 0 |
| Timeline | Code block header, shiki, tables, images, math | Source only | Plain block | Gap |
| Timeline | Tool rows, shimmer, streaming | Source only | Built from source values | Unobserved live; no test turn run |
| Composer | Model picker, traits | Live: present | Read-only model label | Gap |
| Composer | Mentions, commands, attachments, access | Source only | Built, wired to service API | Not run on real service |
| Composer | Queue and steer | Source only | Not built | Gap, backend exists |
| Terminal drawer | Open | Source only | Built | Unobserved live |
| Command palette | Open | Source: 576px wide, 420 tall | Own build | Unobserved live |
| Dialogs, menus, toasts | Open | Source only | Own build | Unobserved live |
| Settings | Layout | Not reached | Grouped surfaces from source | Unobserved live |
| Settings | Engines, Workspace, Updates, Skills, Policy, Audit, Computer, Access | n/a | Loaded on real orbynd, no failed requests | Synthetic data, load only |
| First run | Setup, import | n/a | Passed on real orbynd with a local library | Synthetic data |
| Motion | Hero dock | Source: 0 ms default, cubic-bezier(0.4, 0, 0.2, 1) | Asserted with Web Animations | Live duration unobserved |
| Motion | Status loops, sweep, disclosures | Source values | Asserted computed styles | Live frames unobserved |
| Layout | 1024, 390, light | n/a | Inspected after this pass | No overflow in e2e |
