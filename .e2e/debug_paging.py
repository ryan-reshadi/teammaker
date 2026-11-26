import json
import re
from playwright.sync_api import sync_playwright

BASE = "http://127.0.0.1:5173"

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_context(viewport={"width": 1280, "height": 900}).new_page()
    page.goto(BASE)
    page.wait_for_load_state("networkidle")

    # 12 equal players so every arrangement is a genuinely different partition
    page.request.fetch(
        BASE + "/api/players",
        method="POST",
        headers={"Origin": BASE, "Content-Type": "application/json"},
        data=json.dumps({"players": [{"name": f"E2E Eq {i}", "skill": 5, "tags": []} for i in range(3)]}),
    )
    page.reload()
    page.wait_for_load_state("networkidle")
    page.locator("#tolerance").fill("0")
    page.get_by_role("button", name=re.compile("Generate teams|Generate again")).click()
    page.locator(".arrangement-count").wait_for()
    page.wait_for_timeout(400)

    for step in range(5):
        label = page.locator(".arrangement-count").inner_text()
        teams = page.evaluate("""() => [...document.querySelectorAll('.team')].map(t =>
            [...t.querySelectorAll('.team-player')].map(p => p.textContent))""")
        print(step, label)
        for team in teams:
            print("   ", team)
        page.get_by_label("Next arrangement").click()
        page.wait_for_timeout(400)

    # cleanup
    for player in page.request.get(BASE + "/api/players").json()["players"]:
        if player["name"].startswith("E2E "):
            page.request.delete(BASE + f"/api/players/{player['id']}", headers={"Origin": BASE})
    browser.close()
