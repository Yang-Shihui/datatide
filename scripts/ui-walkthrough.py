"""Headless UI walkthrough: login → chat (live) → datasets → reports."""
import json
import sys
import time

from playwright.sync_api import sync_playwright

BASE = "http://127.0.0.1:8200"
OUT = "/tmp/datatide-shots"
CHROME = "/usr/bin/google-chrome"

with sync_playwright() as p:
    browser = p.chromium.launch(executable_path=CHROME, headless=True)
    ctx = browser.new_context(viewport={"width": 1440, "height": 900}, locale="zh-CN")
    page = ctx.new_page()
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))

    page.goto(BASE)
    page.wait_for_selector(".login-card", timeout=10000)
    page.screenshot(path=f"{OUT}/login.png")

    page.fill("input", "admin")
    page.fill("input[type=password]", "admin123")
    page.click("button.primary")
    page.wait_for_selector(".chat-layout", timeout=10000)
    page.screenshot(path=f"{OUT}/chat-empty.png")

    # live question (multi-tool, chart expected)
    page.fill(".chat-input textarea", "华东区2026年7-8月销售额同比如何？可能是什么原因？画一张月度趋势图")
    page.click(".chat-input button.primary")
    page.wait_for_selector(".msg.assistant .bubble", timeout=15000)
    # wait for done state (send button re-enabled)
    deadline = time.time() + 240
    while time.time() < deadline:
        if page.locator(".chat-input button.primary").is_enabled():
            break
        page.wait_for_timeout(2000)
    page.wait_for_timeout(1500)
    page.screenshot(path=f"{OUT}/chat-answer.png", full_page=True)
    chart_count = page.locator(".chart-box").count()
    answer_len = page.locator(".msg.assistant .bubble").last.inner_text()
    page.screenshot(path=f"{OUT}/chat-top.png")

    # datasets page
    page.click("text=数据集")
    page.wait_for_selector(".ds-grid", timeout=8000)
    page.click("text=查看 schema")
    page.wait_for_selector(".schema-table", timeout=8000)
    page.screenshot(path=f"{OUT}/datasets.png")

    # reports page
    page.click("text=报告")
    page.wait_for_selector(".page", timeout=8000)
    page.screenshot(path=f"{OUT}/reports.png")

    print(json.dumps({
        "js_errors": errors,
        "chart_count": chart_count,
        "answer_head": answer_len[:120],
    }, ensure_ascii=False))
    browser.close()
