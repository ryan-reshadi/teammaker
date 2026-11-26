import json
import re
from playwright.sync_api import sync_playwright

BASE = "http://127.0.0.1:5173"

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    context = browser.new_context(viewport={"width": 1280, "height": 900})
    page = context.new_page()
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
    page.wait_for_timeout(300)

    total = int(re.search(r"of (\d+)", page.locator(".arrangement-count").inner_text()).group(1))
    print("arrangements:", total)
    layouts = []
    for i in range(total):
        label = page.locator(".arrangement-count").inner_text()
        names = tuple(sorted(page.locator(".team-player").all_inner_texts()))
        layouts.append(names)
        print(i, label, "|", " ".join(names)[:70])
        page.get_by_label("Next arrangement").click()
        page.wait_for_timeout(90)

    print("distinct layouts:", len(set(layouts)), "of", len(layouts))

    for player in page.request.get(BASE + "/api/players").json()["players"]:
        if player["name"].startswith("E2E "):
            page.request.delete(BASE + f"/api/players/{player['id']}", headers={"Origin": BASE})
    browser.close()
