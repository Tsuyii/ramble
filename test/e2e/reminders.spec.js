import { test, expect } from "@playwright/test";

// Coverage for the manual-reminder flow (ADR-0004): set a reminder from the per-task bell
// popover and assert the two on-card signals — the bell goes "armed" and a reminder tag
// renders. We seed a task straight through /api/finalize with a pre-resolved due date so
// no AI pass (DeepSeek) runs, then clean it up so the dev store isn't polluted.

const DUE = "2099-12-31"; // far future so the task always lands in an "upcoming" group

test.describe("manual reminders", () => {
  let taskId = null;
  let title = "";

  test.beforeEach(async ({ page, request }) => {
    title = `E2E reminder ${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const res = await request.post("/api/finalize", {
      data: {
        drafts: [
          {
            title,
            due: DUE,
            priority: null,
            projectId: "inbox",
            subtasks: [],
            tags: [],
            questions: [],
          },
        ],
        answers: {},
      },
    });
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    taskId = (body.tasks || []).find((t) => t.title === title)?.id ?? null;
    expect(taskId).toBeTruthy();

    await page.goto("/");
    await expect(page.locator("body")).toHaveClass(/dash/);
  });

  test.afterEach(async ({ request }) => {
    if (taskId) await request.delete(`/api/tasks/${taskId}`);
    taskId = null;
  });

  test("setting a reminder arms the bell and renders a reminder tag", async ({ page }) => {
    const card = page.locator(".task", { hasText: title });
    await expect(card).toBeVisible();

    // No reminder yet: the bell is not armed and there is no reminder tag.
    const bell = card.locator(".taskbtn--remind");
    await expect(bell).not.toHaveAttribute("data-armed", "true");
    await expect(card.locator(".tag--remind")).toHaveCount(0);

    // Open the bell popover and pick a fixed preset.
    await bell.click();
    const popover = page.locator(".rpop");
    await expect(popover).toBeVisible();
    await popover.getByRole("button", { name: "Tomorrow 9am" }).click();

    // Confirmation toast, popover closed.
    await expect(page.locator("#toast")).toContainText("Reminder set");
    await expect(popover).toBeHidden();

    // The list re-renders; the card now shows the armed bell + a reminder tag.
    const armedCard = page.locator(".task", { hasText: title });
    await expect(armedCard.locator('.taskbtn--remind[data-armed="true"]')).toBeVisible();
    const remindTag = armedCard.locator(".tag--remind");
    await expect(remindTag).toBeVisible();
    await expect(remindTag).toContainText("Tomorrow");
  });

  test("the bell popover opens with presets and Escape closes it", async ({ page }) => {
    const card = page.locator(".task", { hasText: title });
    await card.locator(".taskbtn--remind").click();

    const popover = page.locator(".rpop");
    await expect(popover).toBeVisible();
    // The unconditional presets are always offered.
    for (const label of ["In 1 hour", "Tonight", "Tomorrow 9am"]) {
      await expect(popover.getByRole("button", { name: label })).toBeVisible();
    }

    await page.keyboard.press("Escape");
    await expect(popover).toBeHidden();
  });
});
