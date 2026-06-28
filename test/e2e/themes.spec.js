import { test, expect } from "@playwright/test";

// Coverage for the theme switcher (Settings -> Appearance). Default is Paper & Ink;
// six swappable themes apply via documentElement[data-theme]. Switching must update
// the attribute, mark the chosen card pressed, and raise no console errors.
test.describe("theme switcher", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("body")).toHaveClass(/dash/);
    // Open Settings; it lands on the Appearance tab and renders the theme grid.
    await page.locator("#settingsBtnSide").click();
    await expect(page.locator("#settingsModal")).toBeVisible();
    await expect(page.locator("#themeGrid .theme-card").first()).toBeVisible();
  });

  test("boots on the Paper & Ink default", async ({ page }) => {
    await expect(page.locator("html")).toHaveAttribute("data-theme", "paper");
  });

  test("switches between themes and updates data-theme without console errors", async ({ page }) => {
    const errors = [];
    page.on("console", (msg) => msg.type() === "error" && errors.push(msg.text()));

    const grid = page.locator("#themeGrid");
    const ember = grid.getByRole("button", { name: "Graphite & Ember" });
    const cobalt = grid.getByRole("button", { name: "Cobalt & Cream" });

    await ember.click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "ember");
    await expect(grid.getByRole("button", { name: "Graphite & Ember" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    await cobalt.click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "cobalt");
    await expect(grid.getByRole("button", { name: "Cobalt & Cream" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    expect(errors).toEqual([]);
  });

  test("persists the chosen theme across reloads", async ({ page }) => {
    await page.locator("#themeGrid").getByRole("button", { name: "Forest" }).click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "forest");

    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "forest");
  });
});
