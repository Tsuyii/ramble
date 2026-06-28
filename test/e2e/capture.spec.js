import { test, expect } from "@playwright/test";

// Coverage for the capture surface: the orb, the "or type" fallback, and the
// type box that reveals on demand with its "Sort it" submit. No transcription is
// triggered here — we only assert the capture UI wires up and renders.
test.describe("capture surface", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("body")).toHaveClass(/dash/);
  });

  test("renders the orb and the type fallback toggle", async ({ page }) => {
    await expect(page.locator("#capture")).toBeVisible();
    await expect(page.locator("#orb")).toBeVisible();
    await expect(page.locator("#typeToggle")).toBeVisible();
  });

  test("reveals the type box with a Sort it button when the toggle is used", async ({ page }) => {
    const typebox = page.locator("#typebox");
    // The toggle flips the form's `hidden` property; assert on that rather than
    // CSS visibility, since `.typebox` keeps display:flex in dashboard layout.
    await expect(typebox).toHaveJSProperty("hidden", true);

    await page.locator("#typeToggle").click();

    await expect(typebox).toHaveJSProperty("hidden", false);
    await expect(typebox).toBeVisible();
    await expect(page.locator("#typeInput")).toBeFocused();
    await expect(typebox.getByRole("button", { name: "Sort it" })).toBeVisible();
  });

  test("accepts typed input in the brain-dump box", async ({ page }) => {
    await page.locator("#typeToggle").click();
    const input = page.locator("#typeInput");
    await input.fill("call the dentist, finish the deck by friday");
    await expect(input).toHaveValue("call the dentist, finish the deck by friday");
  });
});
