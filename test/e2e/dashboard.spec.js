import { test, expect } from "@playwright/test";

// Smoke coverage for the dashboard shell (ADR-0007 Slice A): the page loads,
// the sidebar renders its nav + folders, and the sidebar filters drive state.
test.describe("dashboard shell", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    // Browser boots into dashboard mode (body.dash), not the widget orb.
    await expect(page.locator("body")).toHaveClass(/dash/);
  });

  test("loads with no console errors", async ({ page }) => {
    const errors = [];
    page.on("console", (msg) => msg.type() === "error" && errors.push(msg.text()));
    await page.reload();
    await expect(page.locator(".sidebar")).toBeVisible();
    expect(errors).toEqual([]);
  });

  test("renders sidebar nav and the New ramble CTA", async ({ page }) => {
    await expect(page.locator("#newRamble")).toBeVisible();
    const nav = page.locator("#sideNav");
    for (const label of ["All tasks", "Today", "Upcoming", "Completed"]) {
      await expect(nav.getByRole("button", { name: label })).toBeVisible();
    }
  });

  test("selecting a sidebar filter marks it current", async ({ page }) => {
    const today = page.locator("#sideNav").getByRole("button", { name: "Today" });
    await today.click();
    await expect(today).toHaveAttribute("aria-current", "true");
  });

  test("renders the Folders section", async ({ page }) => {
    await expect(page.locator(".sidebar__heading", { hasText: "Folders" })).toBeVisible();
    await expect(page.locator("#folderList")).toBeVisible();
  });

  test("opens Settings from the sidebar", async ({ page }) => {
    await page.locator("#settingsBtnSide").click();
    await expect(page.locator("#settingsModal")).toBeVisible();
  });
});
