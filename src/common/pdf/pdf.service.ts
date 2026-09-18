import { Injectable, Logger } from '@nestjs/common';
import type { Browser, Page } from 'puppeteer';

/**
 * HTML → PDF, for documents that leave the building: the offer letter, the
 * appointment letter.
 *
 * Chromium renders the same markup the review modal shows, so the PDF a
 * candidate receives cannot drift from what HR approved on screen. Puppeteer
 * ships its own browser, so this does not depend on anything being installed
 * on the server — set PUPPETEER_EXECUTABLE_PATH to point at an existing
 * Chrome or Edge instead.
 *
 * The browser is launched per document and closed again. Offers are issued a
 * handful of times a day, and a long-lived Chromium is a memory leak waiting
 * to happen on a box that is also running the API.
 */
@Injectable()
export class PdfService {
  private readonly logger = new Logger(PdfService.name);

  /**
   * Returns null rather than throwing when the browser cannot start.
   *
   * A missing Chromium must not stop an offer going out — the caller falls
   * back to sending the letter in the message body, which is what it did
   * before PDFs existed. A silent failure here is visible in the log and in
   * the absence of an attachment, and the candidate still gets their letter.
   */
  async fromHtml(
    html: string,
    opts?: {
      /** Rendered into the top margin of every page. */
      headerHtml?: string;
      /** Rendered into the bottom margin of every page. */
      footerHtml?: string;
      margin?: { top: string; bottom: string; left: string; right: string };
      /**
       * Elements to remove before printing — for content that a page shows in
       * flow but the PDF draws into the margins, such as a letterhead. Removing
       * them here rather than hiding them in `@media print` keeps the browser's
       * own print button working: that path has no margin templates.
       */
      stripSelectors?: string[];
      /**
       * Shrink the content until it fits this many pages.
       *
       * A one-page letter is what HR hands over and what a candidate files, so
       * a letter that runs three lines onto a second sheet is worth setting a
       * point smaller. There is a floor: past it the letter is squinting
       * material, and two readable pages beat one unreadable one.
       */
      fitToPages?: number;
    },
  ): Promise<Buffer | null> {
    let browser: Browser | undefined;
    try {
      const puppeteer = await import('puppeteer');
      browser = await puppeteer.launch({
        headless: true,
        // --no-sandbox is required where the API runs as root in a container;
        // harmless elsewhere. The rest keep Chromium's memory footprint down.
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-gpu',
        ],
      });
      const page = await browser.newPage();
      // `networkidle0` would wait on nothing: the letter carries its images as
      // data URIs, so there is no network to settle.
      await page.setContent(html, { waitUntil: 'domcontentloaded' });
      // The browser's default 8px body margin (~2.1mm) applies to the document
      // but not to the header/footer templates, which Chrome renders outside
      // it — so a letterhead lined up with the page margin sat ~2mm left of the
      // text below it. Zeroed here rather than in the document's own CSS: that
      // markup is also injected into the app's review modal, where a rule on
      // `body` would reach the whole page.
      await page.addStyleTag({ content: 'html,body{margin:0;padding:0}' });
      if (opts?.stripSelectors?.length) {
        await page.evaluate((selectors: string[]) => {
          for (const sel of selectors) {
            document.querySelectorAll(sel).forEach((el) => el.remove());
          }
        }, opts.stripSelectors);
      }
      const hasPad = Boolean(opts?.headerHtml || opts?.footerHtml);
      const render = (scale: number) =>
        page.pdf({
          format: 'A4',
          printBackground: true,
          displayHeaderFooter: hasPad,
          headerTemplate: opts?.headerHtml ?? '<span></span>',
          // An empty template still needs an element, or Chrome prints its own
          // default footer (the URL and page number) instead.
          footerTemplate: opts?.footerHtml ?? '<span></span>',
          margin: opts?.margin ?? {
            top: '18mm',
            bottom: '18mm',
            left: '18mm',
            right: '18mm',
          },
          scale,
        });

      let out = await render(1);
      if (opts?.fitToPages) {
        out = await this.shrinkToFit(page, out, opts.fitToPages, render);
      }
      return Buffer.from(out);
    } catch (e) {
      this.logger.error(`PDF generation failed: ${(e as Error).message}`);
      return null;
    } finally {
      await browser?.close().catch(() => undefined);
    }
  }

  /**
   * Re-render at smaller scales until the document fits.
   *
   * Chrome's own `scale` is used rather than restyling the letter: it re-lays
   * the page out at the smaller size, so lines re-wrap the way they would if
   * the whole letter had been typed a point smaller — nothing is squashed.
   *
   * Steps down rather than binary-searching because the answer is nearly
   * always the first or second step, and each render costs a few hundred
   * milliseconds. Below the floor it gives up and returns the best it has:
   * an unreadable letter is worse than a second sheet.
   */
  private async shrinkToFit(
    page: Page,
    first: Uint8Array,
    maxPages: number,
    render: (scale: number) => Promise<Uint8Array>,
  ): Promise<Uint8Array> {
    const pages = countPdfPages(first);
    if (pages === null || pages <= maxPages) return first;

    let best = first;
    for (const scale of [0.94, 0.88, 0.82, 0.76, 0.7]) {
      const out = await render(scale);
      const n = countPdfPages(out);
      if (n !== null && n <= maxPages) {
        this.logger.log(
          `Letter ran to ${pages} pages; fitted onto ${maxPages} at ${Math.round(scale * 100)}% scale.`,
        );
        return out;
      }
      if (n !== null && n < (countPdfPages(best) ?? Infinity)) best = out;
    }
    this.logger.warn(
      `Letter still runs past ${maxPages} page(s) at the smallest readable scale — sending it as it is.`,
    );
    void page;
    return best;
  }
}

/**
 * How many pages a Chrome-generated PDF has.
 *
 * Counting `/Type /Page` objects works because Chrome writes them uncompressed;
 * null means the structure was not recognised, and the caller then leaves the
 * document alone rather than guessing.
 */
export function countPdfPages(pdf: Uint8Array): number | null {
  const text = Buffer.from(pdf).toString('latin1');
  const matches = text.match(/\/Type\s*\/Page(?![s])/g);
  return matches?.length ?? null;
}
