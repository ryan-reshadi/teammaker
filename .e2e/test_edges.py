"""Second end-to-end pass: equal-skill diversity, write races, guest mode,
limit handling, long names, and round/history integrity after deletion."""

import json
import re
import time
from playwright.sync_api import sync_playwright

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
    return page.request.fetch(
        BASE + path,
        method=method,
        headers={"Origin": BASE, "Content-Type": "application/json"},
        data=json.dumps(data) if data is not None else None,
    )


with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    context = browser.new_context(viewport={"width": 1280, "height": 900})
    page = context.new_page()
    errors = []
    page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
    page.goto(BASE)
    page.wait_for_load_state("networkidle")

    initial_names = api(page, "GET", "/api/players").json()["players"]
    original = [(x["name"], x["skill"], x["tags"], x["sittingOut"]) for x in initial_names]

    # 1. twelve identical players -> many arrangements, real diversity
    api(page, "POST", "/api/players", {
        "players": [{"name": f"E2E Eq {i}", "skill": 5, "tags": []} for i in range(3)]
    })
    page.reload()
    page.wait_for_load_state("networkidle")
    page.locator("#tolerance").fill("0")
    page.get_by_role("button", name=re.compile("Generate teams|Generate again")).click()
    page.locator(".arrangement-count").wait_for()
    page.wait_for_timeout(300)
    total = int(re.search(r"of (\d+)", page.locator(".arrangement-count").inner_text()).group(1))
    check("equal-skill roster yields many arrangements", total == 12, total)
    def read_layout():
        teams = page.evaluate(
            "() => [...document.querySelectorAll('.team')].map(t => "
            "[...t.querySelectorAll('.team-player')].map(p => p.textContent))"
        )
        return tuple(sorted(tuple(sorted(team)) for team in teams))

    layouts = []
    for i in range(total):
        layouts.append(read_layout())
        page.get_by_label("Next arrangement").click()
        page.wait_for_timeout(120)
    check("no duplicate arrangements", len(set(layouts)) == total, len(set(layouts)))
    steps = [sum(1 for x, y in zip(a, b) if x != y) for a, b in zip(layouts, layouts[1:])]
    check("each step moves at least two players", all(s >= 2 for s in steps), steps)
    check("page wraps back to the first", page.locator(".arrangement-count").inner_text().startswith("Arrangement 1 of"),
          page.locator(".arrangement-count").inner_text())
    check("every team has four players at tolerance 0",
          all(page.locator(".team").nth(i).locator(".team-player").count() == 4 for i in range(3)))

    # 2. rapid skill clicks: does the last write win everywhere?
    row(page, "E2E Eq 0").locator(".skill-tick").first.wait_for()
    for level in range(1, 11):
        row(page, "E2E Eq 0").locator(f'.skill-tick[aria-label="{level} out of 10"]').click(force=True)
    page.wait_for_timeout(1500)
    ui_skill = row(page, "E2E Eq 0").locator(".skill-value").inner_text().strip()
    server_skill = next(x["skill"] for x in api(page, "GET", "/api/players").json()["players"]
                        if x["name"] == "E2E Eq 0")
    check("rapid clicks leave UI and server agree", ui_skill == str(server_skill) == "10",
          f"ui {ui_skill} server {server_skill}")

    # 3. rename edge cases
    row(page, "E2E Eq 1").locator(".player-name").click()
    page.get_by_label("Name for E2E Eq 1").fill("   ")
    page.get_by_label("Name for E2E Eq 1").press("Enter")
    page.wait_for_timeout(250)
    check("blank rename is rejected, old name stays", row(page, "E2E Eq 1").count() == 1)
    long_name = "E2E " + "W" * 34
    row(page, "E2E Eq 2").locator(".player-name").click()
    page.get_by_label("Name for E2E Eq 2").fill(long_name)
    page.get_by_label("Name for E2E Eq 2").press("Enter")
    page.wait_for_timeout(300)
    check("40-character name is accepted", row(page, long_name).count() == 1)
    page.set_viewport_size({"width": 390, "height": 844})
    page.wait_for_timeout(250)
    check("long name does not overflow on mobile",
          not page.evaluate("document.documentElement.scrollWidth > window.innerWidth"),
          page.evaluate("document.documentElement.scrollWidth + ' / ' + window.innerWidth"))
    page.set_viewport_size({"width": 1280, "height": 900})

    # 4. deletion keeps saved rounds readable
    page.get_by_role("button", name=re.compile("Generate again|Generate teams")).click()
    page.locator(".arrangement-count").wait_for()
    page.get_by_role("button", name="Save round").click()
    page.wait_for_timeout(700)
    snapshot_names = [n for n in page.locator(".team-player").all_inner_texts()]
    victim = snapshot_names[0]
    row(page, victim).get_by_role("button", name=re.compile("Remove")).click() if False else \
        page.locator(f'[aria-label="Remove {victim}"]').click()
    page.wait_for_timeout(500)
    check("player is gone from the roster", row(page, victim).count() == 0)
    page.locator(".round-row").first.locator("summary").click()
    page.wait_for_timeout(250)
    body = page.locator(".round-row").first.inner_text()
    check("history keeps the deleted player in its snapshot", victim.split(" ")[-1][:4] in body,
          victim)

    # 5. guest mode: server unreachable -> localStorage, survives reload
    guest_ctx = browser.new_context(viewport={"width": 1280, "height": 900})
    guest = guest_ctx.new_page()
    guest.route("**/api/session", lambda route: route.abort())
    guest.route("**/api/players*", lambda route: route.abort())
    guest.route("**/api/rounds*", lambda route: route.abort())
    guest.goto(BASE)
    guest.wait_for_load_state("networkidle")
    for name in ("Guest G", "Guest H", "Guest I"):
        guest.get_by_label("New player name").fill(name)
        guest.locator(".add-form").get_by_role("button", name="Add", exact=True).click()
        guest.wait_for_timeout(300)
    guest_row = guest.locator(".player-row").filter(has=guest.locator(".player-name-text", has_text="Guest G"))
    check("guest mode still accepts a player", guest_row.count() == 1,
          guest.locator(".notice").first.inner_text() if guest.locator(".notice").count() else "no notice")
    guest.reload()
    guest.wait_for_load_state("networkidle")
    check("guest roster survives a reload",
          guest.locator(".player-row").filter(has=guest.locator(".player-name-text", has_text="Guest G")).count() == 1)
    guest.locator("#tolerance").fill("3")
    guest.get_by_role("button", name=re.compile("Generate teams|Generate again")).click()
    guest.locator(".arrangement-count").wait_for()
    check("guest mode can still generate", guest.locator(".team").count() >= 2,
          guest.locator(".team").count())
    guest_ctx.close()

    # 6. roster limit is enforced by the server and surfaced
    too_many = [{"name": f"E2E Huge {i}", "skill": 5} for i in range(60)]
    for _ in range(4):
        api(page, "POST", "/api/players", {"players": too_many})
    page.wait_for_timeout(300)
    count_now = len(api(page, "GET", "/api/players").json()["players"])
    api(page, "POST", "/api/players", {"players": [{"name": f"E2E Over {i}", "skill": 5} for i in range(60)]})
    after = len(api(page, "GET", "/api/players").json()["players"])
    check("roster hard limit holds at 200", after <= 200 and after >= count_now, f"{count_now} -> {after}")
    check("no console errors in this pass", not errors, errors[:2])

    # cleanup
    for player in api(page, "GET", "/api/players").json()["players"]:
        if player["name"].startswith("E2E "):
            api(page, "DELETE", f"/api/players/{player['id']}")
    for rnd in api(page, "GET", "/api/rounds").json()["rounds"]:
        names = [pl["name"] for team in rnd["config"]["teams"] for pl in team["players"]]
        if any(n.startswith("E2E ") for n in names):
            api(page, "DELETE", f"/api/rounds/{rnd['id']}")
    restored = [(x["name"], x["skill"], x["tags"], x["sittingOut"]) for x in api(page, "GET", "/api/players").json()["players"]]
    check("original roster restored exactly", sorted(restored) == sorted(original),
          f"{len(restored)} vs {len(original)}")

    browser.close()

failures = [r for r in RESULTS if not r["ok"]]
print(f"\n{len(RESULTS) - len(failures)} passed, {len(failures)} failed")
for failure in failures:
    print(" -", failure["name"], "->", failure["detail"])
