import { test, expect } from "@playwright/test";

// Coverage for the capture surface: the orb and the type-to-brain-dump box.
// The "or type" toggle only appears when voice is available (a Groq key is set).
// With no key (e.g. in CI) the app boots straight into the type box and hides the
// toggle — both paths must leave a usable type box, so these tests handle both.
test.describe("capture surface", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("body")).toHaveClass(/dash/);
  });

  // Ensures the type box is open regardless of whether voice is available.
  async function openTypebox(page) {
    const toggle = page.locator("#typeToggle");
    if (await toggle.isVisible()) await toggle.click();
    await expect(page.locator("#typebox")).toHaveJSProperty("hidden", false);
  }

  test("renders the orb and a path to the type box", async ({ page }) => {
    await expect(page.locator("#capture")).toBeVisible();
    await expect(page.locator("#orb")).toBeVisible();
    // Either the voice fallback toggle is offered, or the type box is already open.
    const toggleVisible = await page.locator("#typeToggle").isVisible();
    const typeboxOpen = await page.locator("#typebox").evaluate((el) => !el.hidden);
    expect(toggleVisible || typeboxOpen).toBeTruthy();
  });

  test("the type box opens with a Sort it button", async ({ page }) => {
    await openTypebox(page);
    const typebox = page.locator("#typebox");
    await expect(typebox).toBeVisible();
    await expect(typebox.getByRole("button", { name: "Sort it" })).toBeVisible();
  });

  test("accepts typed input in the brain-dump box", async ({ page }) => {
    await openTypebox(page);
    const input = page.locator("#typeInput");
    await input.fill("call the dentist, finish the deck by friday");
    await expect(input).toHaveValue("call the dentist, finish the deck by friday");
  });
});
