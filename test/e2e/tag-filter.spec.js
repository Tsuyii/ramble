import { test, expect } from "@playwright/test";

// Tag filter (ADR-0008): a chip row above the list narrows tasks to a tag. Operates on
// existing tasks (manual creation lands later) and restores any data it touches.

async function showSomeTasks(page) {
  const nav = page.locator("#sideNav");
  await nav.getByRole("button", { name: "All tasks" }).click();
  if ((await page.locator(".task__title").count()) === 0) {
    await nav.getByRole("button", { name: "Completed" }).click();
  }
}

test("a tag chip narrows the task list", async ({ page }) => {
  await page.goto("/");
  const id = await page.evaluate(async () => {
    const d = await (await fetch("/api/state")).json();
    const t = d.tasks[0];
    if (!t) return null;
    await fetch("/api/tasks/" + t.id, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ tags: ["zfiltertest"] }) });
    return t.id;
  });
  test.skip(!id, "no tasks to tag");

  await page.reload();
  await showSomeTasks(page);
  const chip = page.locator(".tagfilter__chip", { hasText: "zfiltertest" });
  await expect(chip).toBeVisible();
  await chip.click();
  await expect(chip).toHaveAttribute("aria-pressed", "true");
  const cards = page.locator(".task");
  await expect(cards).not.toHaveCount(0);
  for (const card of await cards.all()) {
    await expect(card.locator(".tag--label", { hasText: "zfiltertest" })).toHaveCount(1);
  }

  await page.evaluate(async (id) => {
    await fetch("/api/tasks/" + id, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ tags: [] }) });
  }, id);
});
