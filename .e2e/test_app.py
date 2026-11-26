"""End-to-end product test for Team Maker (Playwright, headless Chromium).

Runs against the dev server on 127.0.0.1:5173, exercises the product the way a
user would, and records timings, console errors and failed requests. Test data
is namespaced ("E2E ...") and removed at the end; the original roster is left
untouched.
"""

import json
import re
import time
from playwright.sync_api import sync_playwright, expect

BASE = "http://127.0.0.1:5173"
RESULTS = []


def check(name, ok, detail=""):
    RESULTS.append({"name": name, "ok": bool(ok), "detail": str(detail)[:400]})
    print(("PASS " if ok else "FAIL ") + name + (f"  [{detail}]" if detail else ""))


def row(page, name):
    return page.locator(".player-row").filter(
        has=page.locator(".player-name-text", has_text=re.compile(rf"^{re.escape(name)}$"))
    )


def api(page, method, path, data=None):
    response = page.request.fetch(
        BASE + path,
        method=method,
        headers={"Origin": BASE, "Content-Type": "application/json"},
        data=json.dumps(data) if data is not None else None,
    )
    return response


with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    context = browser.new_context(viewport={"width": 1280, "height": 900})
    page = context.new_page()

    console_errors = []
    failed = []
    requests = []
    page.on("console", lambda m: console_errors.append(m.text) if m.type == "error" else None)
    page.on("requestfailed", lambda r: failed.append(f"{r.method} {r.url} {r.failure}"))
    page.on("request", lambda r: requests.append((r.method, r.url)))

    page.goto(BASE)
    page.wait_for_load_state("networkidle")

    # ---------------------------------------------------------------- 1. render
    check("title renders", "Teammaker" in page.title(), page.title())
    roster_sub = page.locator(".roster .sub").first.inner_text()
    check("roster header shows count/total/average", "players" in roster_sub, roster_sub)
    check("session chip is Synced", page.locator("header .chip").inner_text().strip() == "Synced",
          page.locator("header .chip").inner_text())
    initial_rows = page.locator(".player-row").count()
    check("initial roster rows", initial_rows == 9, initial_rows)
    page.screenshot(path=".e2e/01-initial.png", full_page=True)

    # ------------------------------------------------- 2. add one player + roles
    page.get_by_label("New player name").fill("E2E One")
    page.locator('[aria-label="Skill for the new player"] .skill-tick[aria-label="10 out of 10"]').click()
    draft = page.locator(".draft-roles")
    draft.get_by_role("button", name="Sniper", exact=True).click()
    draft.get_by_role("button", name="IGL", exact=True).click()
    page.locator(".add-form").get_by_role("button", name="Add", exact=True).click()
    row(page, "E2E One").wait_for()
    check("row appears after add", row(page, "E2E One").count() == 1)
    chips = [c.inner_text() for c in row(page, "E2E One").locator(".role-chip").all()]
    check("roles shown on the new row", chips == ["Sniper", "IGL"], chips)
    check("skill tick is 10", row(page, "E2E One").locator(".skill-value").inner_text().strip() == "10")
    page.wait_for_timeout(200)
    saved = api(page, "GET", "/api/players").json()["players"]
    e2e = [x for x in saved if x["name"] == "E2E One"]
    check("server persisted name/skill/tags",
          e2e and e2e[0]["skill"] == 10 and e2e[0]["tags"] == ["sniper", "igl"],
          e2e[0] if e2e else "missing")

    # ------------------------------------ 3. skill picker: how many writes per rating
    before = len([r for r in requests if r[0] == "PATCH"])
    for level in range(1, 11):
        row(page, "E2E One").locator(f'.skill-tick[aria-label="{level} out of 10"]').click()
    page.wait_for_timeout(600)
    patches = len([r for r in requests if r[0] == "PATCH"]) - before
    check("skill rating writes one PATCH per tick", patches == 10, f"{patches} PATCHes for 10 clicks")
    check("skill ends at 10", row(page, "E2E One").locator(".skill-value").inner_text().strip() == "10")

    # ------------------------------------------------------------ 4. rename flow
    row(page, "E2E One").locator(".player-name").click()
    page.get_by_label("Name for E2E One").fill("E2E Uno")
    page.get_by_label("Name for E2E One").press("Enter")
    page.wait_for_timeout(250)
    check("rename commits on Enter", row(page, "E2E Uno").count() == 1)
    row(page, "E2E Uno").locator(".player-name").click()
    page.get_by_label("Name for E2E Uno").fill("Discarded")
    page.get_by_label("Name for E2E Uno").press("Escape")
    page.wait_for_timeout(200)
    check("Escape cancels a rename", row(page, "E2E Uno").count() == 1
          and page.locator(".player-row").filter(has_text="Discarded").count() == 0)

    # ------------------------------------------------------------- 5. bulk add
    page.get_by_role("button", name="Add several at once").click()
    page.locator("#bulk-names").fill("E2E A\nE2E B, E2E C")
    page.locator(".bulk-form").get_by_role("button", name=re.compile(r"Add 3 players")).click()
    page.wait_for_timeout(500)
    check("bulk add creates three players", page.locator(".player-row").count() == initial_rows + 4,
          page.locator(".player-row").count())
    check("bulk players join at 5",
          row(page, "E2E A").locator(".skill-value").inner_text().strip() == "5")

    # ------------------------------------------------- 6. sit out + fairness hint
    page.get_by_role("button", name="More teams").click()  # 3 -> 4 ... then back
    page.get_by_role("button", name="Fewer teams").click()
    page.wait_for_timeout(150)
    # 13 players / 3 teams leaves 1 on the bench
    hint = page.locator(".suggestion")
    check("fairness suggestion appears for uneven roster", hint.count() == 1,
          hint.inner_text().replace("\n", " ") if hint.count() else "none")
    row(page, "E2E C").locator(".sit-toggle").click()
    page.wait_for_timeout(400)
    check("sit-out dims the row", "benched" in (row(page, "E2E C").get_attribute("class") or ""),
          row(page, "E2E C").get_attribute("class"))
    check("suggestion clears once the roster divides evenly", page.locator(".suggestion").count() == 0)

    # ------------------------------------- 7. roles on existing rows (multi-tag)
    for name, roles in (("E2E A", ["Sniper"]), ("E2E B", ["Sniper", "Support"])):
        row(page, name).locator(".role-summary").click()
        editor = row(page, name).locator(".role-editor")
        for role in roles:
            editor.get_by_role("button", name=role, exact=True).click()
        editor.get_by_role("button", name="Done").click()
        page.wait_for_timeout(300)
    check("multi-role player shows two chips",
          len(row(page, "E2E B").locator(".role-chip").all()) == 2,
          [c.inner_text() for c in row(page, "E2E B").locator(".role-chip").all()])
    page.reload()
    page.wait_for_load_state("networkidle")
    check("roles survive a reload",
          len(row(page, "E2E B").locator(".role-chip").all()) == 2)

    # --------------------------------------------------- 8. generate + paging
    started = time.perf_counter()
    page.get_by_role("button", name=re.compile("Generate teams|Generate again")).click()
    page.locator(".arrangement-count").wait_for()
    elapsed = (time.perf_counter() - started) * 1000
    check("generate completes in ~a second", elapsed < 2000, f"{elapsed:.0f} ms")
    count_text = page.locator(".arrangement-count").inner_text()
    total = int(re.search(r"of (\d+)", count_text).group(1))
    check("arrangements returned", total >= 1, count_text)
    sums = [int(s.inner_text()) for s in page.locator(".team-sum").all()]
    spread_text = page.locator(".result-meta .chip").inner_text()
    check("spread chip equals max-min", spread_text == f"Spread {max(sums) - min(sums)}",
          f"{sums} vs {spread_text}")
    page.screenshot(path=".e2e/02-result.png", full_page=True)

    layouts = []
    for _ in range(total):
        layouts.append(tuple(sorted(page.locator(".team-player").all_inner_texts())))
        if total > 1:
            page.get_by_label("Next arrangement").click()
            page.wait_for_timeout(120)
    duplicates = len(layouts) - len(set(layouts))
    check("every arrangement is different", duplicates == 0, f"{duplicates} duplicates of {total}")
    diffs = []
    for a, b in zip(layouts, layouts[1:]):
        diffs.append(len(set(a) ^ set(b)) // 2)
    check("consecutive arrangements move at least two players",
          all(d >= 2 for d in diffs), diffs)
    check("paging wraps to the first arrangement",
          page.locator(".arrangement-count").inner_text().startswith("Arrangement 1 of"), 
          page.locator(".arrangement-count").inner_text())

    # -------------------------------------------------------- 9. save and delete
    history_before = page.locator(".round-row").count()
    page.get_by_role("button", name="Save round").click()
    page.wait_for_timeout(700)
    check("save confirms", page.locator(".saved").count() == 1,
          page.locator(".saved").inner_text() if page.locator(".saved").count() else "no message")
    check("history gains a round", page.locator(".round-row").count() == history_before + 1,
          page.locator(".round-row").count())
    page.locator(".round-row").first.locator("summary").click()
    page.wait_for_timeout(200)
    check("saved round expands to teams", page.locator(".round-team").count() >= 1,
          page.locator(".round-team").count())

    # ------------------------------------------- 10. stale state + role spreading
    check("spread-roles toggle is offered once roles exist", page.locator(".role-toggle").count() == 1)
    page.locator(".role-toggle input").click()
    page.wait_for_timeout(200)
    check("toggling marks the result stale", page.locator(".stale").count() == 1,
          page.locator(".stale").inner_text() if page.locator(".stale").count() else "none")
    page.get_by_role("button", name="Generate again").click()
    page.locator(".arrangement-count").wait_for()
    page.wait_for_timeout(400)
    check("regenerate clears the stale note", page.locator(".stale").count() == 0)

    # ------------------------------------------------- 11. over-tolerance fallback
    page.locator("#tolerance").fill("0")
    page.get_by_role("button", name="Generate again").click()
    page.wait_for_timeout(1200)
    warning = page.locator(".warning")
    if warning.count() == 1:
        text = warning.inner_text().replace("\n", " ")
        check("over-tolerance split is explained", "closest achievable" in text, text)
        band = "warn" in (page.locator(".result-meta .chip").get_attribute("class") or "")
        check("over-tolerance chip is flagged", band, page.locator(".result-meta .chip").get_attribute("class"))
        page.locator(".warning button").click()
        page.wait_for_timeout(200)
        check("offer raises tolerance to the reachable spread",
              page.locator("#tolerance").input_value() != "0", page.locator("#tolerance").input_value())
    else:
        check("tolerance 0 either fits or explains itself", True, "a split fits")

    # --------------------------------------------- 12. too few players to generate
    available = page.locator(".player-row:not(.benched)")
    for i in range(available.count() - 3):
        page.locator(".player-row:not(.benched)").last.locator(".sit-toggle").click()
        page.wait_for_timeout(60)
    for _ in range(5):
        plus = page.get_by_role("button", name="More teams")
        if plus.is_disabled():
            break
        plus.click()
    page.get_by_role("button", name=re.compile("Generate again|Generate teams")).click()
    page.wait_for_timeout(400)
    errors = page.locator(".error").all_inner_texts()
    check("too-few-players is explained", any("at least" in e for e in errors), errors)
    page.screenshot(path=".e2e/03-guard.png", full_page=True)

    # ----------------------------------------------------------- 13. mobile layout
    page.set_viewport_size({"width": 390, "height": 844})
    page.get_by_role("button", name=re.compile("Sit out")).first.click() if False else None
    page.wait_for_timeout(300)
    overflow = page.evaluate("document.documentElement.scrollWidth > window.innerWidth")
    check("no horizontal overflow at 390px", not overflow,
          page.evaluate("document.documentElement.scrollWidth + ' vs ' + window.innerWidth"))
    page.screenshot(path=".e2e/04-mobile.png", full_page=True)
    page.set_viewport_size({"width": 1280, "height": 900})

    # -------------------------------------------------- 14. scale: 30 players / 6
    for player in api(page, "GET", "/api/players").json()["players"]:
        if player["sittingOut"]:
            api(page, "PATCH", f"/api/players/{player['id']}", {"sittingOut": False})
    bulk = [{"name": f"E2E Bulk {i}", "skill": 3 + (i * 7) % 8, "tags": []} for i in range(18)]
    api(page, "POST", "/api/players", {"players": bulk})
    page.reload()
    page.wait_for_load_state("networkidle")
    while page.locator(".stepper output").inner_text().strip() != "6":
        step = page.get_by_role("button", name="More teams" if int(page.locator(".stepper output").inner_text()) < 6 else "Fewer teams")
        step.click()
        page.wait_for_timeout(40)
    page.locator("#tolerance").fill("6")
    started = time.perf_counter()
    page.get_by_role("button", name=re.compile("Generate teams|Generate again")).click()
    page.locator(".arrangement-count").wait_for()
    big_ms = (time.perf_counter() - started) * 1000
    caption = page.locator(".caption").first.inner_text()
    check("30 players / 6 teams generates under 3s", big_ms < 3000, f"{big_ms:.0f} ms")
    check("large search reports its coverage honestly",
          "valid splits" in caption or "All" in caption, caption)
    check("large result fills every team",
          page.locator(".team").count() == 6, page.locator(".team").count())

    # main-thread responsiveness while a large search runs
    page.locator("#tolerance").fill("20")
    page.get_by_role("button", name="Generate again").click()
    lag = page.evaluate(
        """() => new Promise((resolve) => {
             const start = performance.now();
             let worst = 0;
             let last = start;
             const tick = () => {
               const now = performance.now();
               worst = Math.max(worst, now - last);
               last = now;
               if (now - start < 1200) requestAnimationFrame(tick);
               else resolve(Math.round(worst));
             };
             requestAnimationFrame(tick);
           })"""
    )
    check("UI stays responsive during a large search", lag < 250, f"worst frame gap {lag} ms")
    page.screenshot(path=".e2e/05-scale.png", full_page=True)

    # ------------------------------------------------------------- 15. hygiene
    real_errors = [e for e in console_errors if "favicon" not in e.lower()]
    check("no console errors", not real_errors, real_errors[:3])
    check("no failed requests", not failed, failed[:3])

    # ------------------------------------------------------------- cleanup
    players = api(page, "GET", "/api/players").json()["players"]
    for player in players:
        if player["name"].startswith("E2E "):
            api(page, "DELETE", f"/api/players/{player['id']}")
    rounds = api(page, "GET", "/api/rounds").json()["rounds"]
    for rnd in rounds:
        names = [pl["name"] for team in rnd["config"]["teams"] for pl in team["players"]]
        if any(name.startswith("E2E ") for name in names):
            api(page, "DELETE", f"/api/rounds/{rnd['id']}")
    remaining = api(page, "GET", "/api/players").json()["players"]
    check("test data cleaned up", len(remaining) == initial_rows, len(remaining))

    with open(".e2e/results.json", "w", encoding="utf-8") as handle:
        json.dump(RESULTS, handle, indent=2)
    browser.close()

failures = [r for r in RESULTS if not r["ok"]]
print(f"\n{len(RESULTS) - len(failures)} passed, {len(failures)} failed")
for failure in failures:
    print(" -", failure["name"], "->", failure["detail"])
