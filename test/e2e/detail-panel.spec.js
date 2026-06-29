import { test, expect } from "@playwright/test";

// Task detail panel (ADR-0007). Operates on existing tasks (manual creation lands later)
// and restores any data it touches. Tag-filter has its own spec.

async function taskCount(page) {
  return page.evaluate(async () => (await (await fetch("/api/state")).json()).tasks.length);
}

async function showSomeTasks(page) {
  const nav = page.locator("#sideNav");
  await nav.getByRole("button", { name: "All tasks" }).click();
  if ((await page.locator(".task__title").count()) === 0) {
    await nav.getByRole("button", { name: "Completed" }).click();
  }
}

test.describe("task detail panel", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    test.skip((await taskCount(page)) === 0, "no tasks to exercise the panel");
  });

  test("opens on task click, shows the title, closes on Escape", async ({ page }) => {
    await showSomeTasks(page);
    await page.locator(".task__title").first().click();
    await expect(page.locator("#detailPanel")).toBeVisible();
    await expect(page.locator("#detailTitleInput")).toHaveValue(/.+/);
    await page.keyboard.press("Escape");
    await expect(page.locator("#detailPanel")).toBeHidden();
  });

  test("adds and removes a tag in the panel", async ({ page }) => {
    await showSomeTasks(page);
    await page.locator(".task__title").first().click();
    await page.locator(".dtag__add input").fill("qa-temp");
    await page.locator(".dtag__add input").press("Enter");
    const chip = page.locator(".dtag", { hasText: "qa-temp" });
    await expect(chip).toBeVisible();
    await chip.locator(".dtag__x").click();
    await expect(page.locator(".dtag", { hasText: "qa-temp" })).toHaveCount(0);
    await page.evaluate(async () => {
      const d = await (await fetch("/api/state")).json();
      for (const t of d.tasks.filter((x) => (x.tags || []).includes("qa-temp"))) {
        await fetch("/api/tasks/" + t.id, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ tags: (t.tags || []).filter((g) => g !== "qa-temp") }) });
      }
    });
  });
});
