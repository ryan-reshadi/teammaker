import json
import re
from playwright.sync_api import sync_playwright

BASE = "http://127.0.0.1:5173"

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_context(viewport={"width": 1280, "height": 900}).new_page()
    page.goto(BASE)
    page.wait_for_load_state("networkidle")
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

    print("--- fast loop, 90ms between read and click ---")
    labels = []
    for step in range(6):
        labels.append(page.locator(".arrangement-count").inner_text())
        teams = page.evaluate(
            "() => [...document.querySelectorAll('.team')].map(t => [...t.querySelectorAll('.team-player')].map(p => p.textContent).join(','))"
        )
        print(step, labels[-1], "|", teams[0][:60])
        page.get_by_label("Next arrangement").click()
        page.wait_for_timeout(90)

    print("--- slow loop, 400ms ---")
    for step in range(4):
        print(step, page.locator(".arrangement-count").inner_text())
        page.get_by_label("Next arrangement").click()
        page.wait_for_timeout(400)

    # how many distinct labels did the fast loop see, and did two rapid clicks skip?
    print("--- double click test ---")
    start = page.locator(".arrangement-count").inner_text()
    page.get_by_label("Next arrangement").dblclick()
    page.wait_for_timeout(300)
    print("after dblclick:", start, "->", page.locator(".arrangement-count").inner_text())

    for player in page.request.get(BASE + "/api/players").json()["players"]:
        if player["name"].startswith("E2E "):
            page.request.delete(BASE + f"/api/players/{player['id']}", headers={"Origin": BASE})
    browser.close()
