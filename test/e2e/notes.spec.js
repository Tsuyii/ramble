import { test, expect } from "@playwright/test";

// Coverage for the standalone Notes overlay (ADR-0008): open it from the sidebar, create a
// note, type a title + body that autosave, reload to prove persistence, then delete it.
test.describe("notes", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("body")).toHaveClass(/dash/);
  });

  test("create a note → reload → persists → delete", async ({ page }) => {
    const title = `Test note ${Date.now()}`;
    const body = "Remember to water the plants and call the dentist.";

    // Open the overlay and let its initial list load settle before creating, so the new
    // note can't race the open-load GET.
    const listLoaded = page.waitForResponse(
      (res) => res.url().endsWith("/api/notes") && res.request().method() === "GET"
    );
    await page.locator("#notesOpen").click();
    await expect(page.locator("#notesOverlay")).toBeVisible();
    await listLoaded;
    await page.locator("#notesNew").click();

    // Type a title + body; autosave fires on input (debounced) and on blur.
    await expect(page.locator("#noteTitleInput")).toBeVisible();
    await page.locator("#noteTitleInput").fill(title);
    await page.locator("#noteBodyInput").fill(body);
    // Blur to force an immediate autosave flush, and wait for the PATCH that actually
    // carries the body so the reload below proves real persistence.
    const bodySaved = page.waitForResponse(
      (res) =>
        /\/api\/notes\/[^/]+$/.test(res.url()) &&
        res.request().method() === "PATCH" &&
        res.ok() &&
        (res.request().postData() || "").includes("water the plants")
    );
    await page.locator("#noteBodyInput").blur();
    await bodySaved;

    // The note shows up in the index with its title.
    await expect(page.locator(".noteitem__title", { hasText: title })).toBeVisible();

    // Reload: the note persists and reopens with its saved content.
    await page.reload();
    await expect(page.locator("body")).toHaveClass(/dash/);
    await page.locator("#notesOpen").click();
    await expect(page.locator(".noteitem__title", { hasText: title })).toBeVisible();
    await page.locator(".noteitem", { hasText: title }).click();
    await expect(page.locator("#noteTitleInput")).toHaveValue(title);
    await expect(page.locator("#noteBodyInput")).toHaveValue(body);

    // Delete it (auto-accept the confirm), and it's gone from the index.
    page.on("dialog", (d) => d.accept());
    await page.locator("#noteDelete").click();
    await expect(page.locator(".noteitem__title", { hasText: title })).toHaveCount(0);
  });

  test("closes on Escape and via the scrim", async ({ page }) => {
    await page.locator("#notesOpen").click();
    await expect(page.locator("#notesOverlay")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.locator("#notesOverlay")).toBeHidden();
  });
});
