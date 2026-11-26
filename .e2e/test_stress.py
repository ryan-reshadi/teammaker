"""Stress pass at the roster ceiling (200 players) and a few remaining edges."""

import json
import re
import time
from playwright.sync_api import sync_playwright

BASE = "http://127.0.0.1:5173"
RESULTS = []


def check(name, ok, detail=""):
    RESULTS.append({"name": name, "ok": bool(ok), "detail": str(detail)[:400]})
    print(("PASS " if ok else "FAIL ") + name + (f"  [{detail}]" if detail else ""))


with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_context(viewport={"width": 1280, "height": 900}).new_page()
    errors = []
    page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
    page.goto(BASE)
    page.wait_for_load_state("networkidle")

    # fill to 200 players in server batches of 50
    existing = len(page.request.get(BASE + "/api/players").json()["players"])
    need = 200 - existing
    added = 0
    while added < need:
        size = min(50, need - added)
        page.request.fetch(
            BASE + "/api/players",
            method="POST",
            headers={"Origin": BASE, "Content-Type": "application/json"},
            data=json.dumps({"players": [
                {"name": f"E2E P{added + i}", "skill": 1 + ((added + i) % 10), "tags": ["sniper"] if (added + i) % 5 == 0 else []}
                for i in range(size)
            ]}),
        )
        added += size
    total_players = len(page.request.get(BASE + "/api/players").json()["players"])
    check("roster reaches 200", total_players == 200, total_players)

    started = time.perf_counter()
    page.reload()
    page.wait_for_load_state("networkidle")
    load_ms = (time.perf_counter() - started) * 1000
    rows = page.locator(".player-row").count()
    check("200 rows render", rows == 200, rows)
    check("200-player load under 4s", load_ms < 4000, f"{load_ms:.0f} ms")

    started = time.perf_counter()
    for _ in range(6):
        plus = page.get_by_role("button", name="More teams")
        if plus.is_disabled():
            break
        plus.click()
    page.locator("#tolerance").fill("4")
    page.get_by_role("button", name=re.compile("Generate teams|Generate again")).click()
    page.locator(".arrangement-count").wait_for()
    generate_ms = (time.perf_counter() - started) * 1000
    check("200 players / 8 teams generates under 3s", generate_ms < 3000, f"{generate_ms:.0f} ms")
    check("every team column rendered", page.locator(".team").count() == 8, page.locator(".team").count())
    per_team = page.evaluate("() => [...document.querySelectorAll('.team')].map(t => t.querySelectorAll('.team-player').length)")
    check("team sizes are 25/25/25/25/25/25/25/25", per_team == [25] * 8, per_team)
    check("roster chips still correct", page.locator(".team-roles").count() >= 1)

    # typing in the add box must stay responsive while the page holds 200 rows
    started = time.perf_counter()
    page.get_by_label("New player name").fill("E2E Typing")
    typing_ms = (time.perf_counter() - started) * 1000
    check("typing stays responsive at 200 rows", typing_ms < 500, f"{typing_ms:.0f} ms")
    page.get_by_label("New player name").fill("")

    # memory / DOM sanity
    nodes = page.evaluate("document.querySelectorAll('*').length")
    check("DOM stays reasonable (< 12k nodes)", nodes < 12000, nodes)
    check("no console errors at scale", not errors, errors[:2])

    # cleanup
    for player in page.request.get(BASE + "/api/players").json()["players"]:
        if player["name"].startswith("E2E "):
            page.request.delete(BASE + f"/api/players/{player['id']}", headers={"Origin": BASE})
    remaining = len(page.request.get(BASE + "/api/players").json()["players"])
    check("roster restored", remaining == existing, remaining)
    browser.close()

failures = [r for r in RESULTS if not r["ok"]]
print(f"\n{len(RESULTS) - len(failures)} passed, {len(failures)} failed")
for failure in failures:
    print(" -", failure["name"], "->", failure["detail"])
