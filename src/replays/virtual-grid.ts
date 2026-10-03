// Renders only the rows of a large card grid that are on screen (plus some
// overscan). Cards are absolutely positioned inside a container as tall as
// the whole grid, so adding a row lays out only that row's cards, and
// scrolling stays on the compositor. Columns and gaps still come from the
// container's CSS grid definition (including media queries).

export type VirtualGridOptions = {
  scroller: HTMLElement;
  container: HTMLElement;
  /** Creates elements for items, in order. */
  create(ids: number[]): HTMLElement[];
  /** Brings a mounted element up to date with the current state. */
  update(element: HTMLElement, id: number): void;
  /** Row height to use before a card has been measured. */
  estimateRowHeight(): number;
  /** Called when the column width changes. */
  onLayout?(columnWidth: number): void;
};

// Detached cards kept for scrolling back; beyond this they are rebuilt.
const CACHE_LIMIT = 600;

export class VirtualGrid {
  private items: number[] = [];
  private readonly cache = new Map<number, HTMLElement>();
  private readonly mounted = new Map<number, HTMLElement>();
  private readonly positions = new WeakMap<HTMLElement, string>();
  private trackCount = 1;
  private collapsesEmptyTracks = false;
  private columns = 1;
  private rowHeight = 0;
  private rowGap = 0;
  private columnGap = 0;
  private width = 0;
  private columnWidth = 0;
  private offsetTop = 0;
  private firstRow = -1;
  private lastRow = -1;
  private frame = 0;
  private measured = false;
  private rowMeasured = false;
  private readonly resizeObserver: ResizeObserver;
  private readonly onScroll = () => this.schedule();

  constructor(private readonly options: VirtualGridOptions) {
    options.scroller.addEventListener("scroll", this.onScroll, { passive: true });
    this.resizeObserver = new ResizeObserver(() => {
      // Layout is current here, so this read is free. Only a new width (a
      // resize, or the scrollbar appearing) changes the columns; a new height
      // only changes which rows are needed.
      if (!this.measured || Math.abs(options.container.getBoundingClientRect().width - this.width) > 0.5) {
        this.relayout();
      } else {
        this.invalidateRange();
        this.render();
      }
    });
    this.resizeObserver.observe(options.scroller);
  }

  get mountedElements(): ReadonlyMap<number, HTMLElement> {
    return this.mounted;
  }

  setItems(items: number[]) {
    const same = items.length === this.items.length && items.every((id, index) => id === this.items[index]);
    if (same) return;
    this.items = items;
    this.invalidateRange();
    this.render();
  }

  /** Re-applies state to every mounted element. */
  refresh() {
    for (const [id, element] of this.mounted) this.options.update(element, id);
  }

  /** Drops every cached element so they are rebuilt from the current state. */
  rebuild() {
    for (const element of this.mounted.values()) element.remove();
    this.mounted.clear();
    this.cache.clear();
    this.invalidateRange();
    this.render();
  }

  /** Re-measures columns and row height, e.g. after the card size changes. */
  relayout() {
    this.measured = false;
    this.rowMeasured = false;
    this.invalidateRange();
    this.render();
  }

  destroy() {
    cancelAnimationFrame(this.frame);
    this.frame = 0;
    this.options.scroller.removeEventListener("scroll", this.onScroll);
    this.resizeObserver.disconnect();
    this.mounted.clear();
    this.cache.clear();
  }

  private invalidateRange() {
    this.firstRow = this.lastRow = -1;
  }

  private schedule() {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.render();
    });
  }

  private measure() {
    const { scroller, container } = this.options;
    const style = getComputedStyle(container);
    const tracks = style.gridTemplateColumns.split(" ").filter((track) => track && track !== "none");
    this.trackCount = Math.max(1, tracks.length);
    // Cards are out of flow, so an auto-fit grid reports every track as
    // collapsed. Like the CSS grid, fewer cards than tracks share the width.
    this.collapsesEmptyTracks = tracks.length > 1 && tracks.every((track) => parseFloat(track) === 0);
    this.rowGap = parseFloat(style.rowGap) || 0;
    this.columnGap = parseFloat(style.columnGap) || 0;
    this.width = container.getBoundingClientRect().width;
    this.offsetTop = container.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
    this.measured = true;
  }

  private updateColumns() {
    const columns = this.collapsesEmptyTracks
      ? Math.max(1, Math.min(this.trackCount, this.items.length))
      : this.trackCount;
    const columnWidth = Math.max(0, (this.width - this.columnGap * (columns - 1)) / columns);
    const changed = columns !== this.columns || Math.abs(columnWidth - this.columnWidth) > 0.1;
    this.columns = columns;
    if (changed) {
      this.columnWidth = columnWidth;
      this.options.onLayout?.(columnWidth);
    }
    return changed;
  }

  private render() {
    const { scroller, container } = this.options;
    if (!container.isConnected) return;
    if (!this.measured) this.measure();
    // New columns move every card, so the range is placed again.
    if (this.updateColumns()) this.invalidateRange();
    if (!this.rowHeight || !this.rowMeasured) this.rowHeight = this.options.estimateRowHeight();
    const stride = this.rowHeight + this.rowGap;
    const rows = Math.ceil(this.items.length / this.columns);
    const viewport = scroller.clientHeight || window.innerHeight;
    const overscan = Math.max(2 * stride, viewport * 0.6);
    const top = scroller.scrollTop - this.offsetTop;
    const firstRow = rows ? Math.max(0, Math.min(rows - 1, Math.floor((top - overscan) / stride))) : 0;
    const lastRow = rows ? Math.max(firstRow, Math.min(rows - 1, Math.ceil((top + viewport + overscan) / stride))) : -1;
    if (firstRow === this.firstRow && lastRow === this.lastRow) return;
    this.firstRow = firstRow;
    this.lastRow = lastRow;

    const height = rows ? `${Math.max(0, rows * stride - this.rowGap)}px` : "0px";
    if (container.style.height !== height) {
      container.style.height = height;
      // A new height can add or remove the scrollbar. Checking now, before
      // cards are placed, keeps them from being placed twice.
      if (Math.abs(container.getBoundingClientRect().width - this.width) > 0.5) {
        this.measured = false;
        this.invalidateRange();
        this.render();
        return;
      }
    }
    this.reconcile(this.items.slice(firstRow * this.columns, (lastRow + 1) * this.columns), firstRow * this.columns);

    // The first rendered card gives the real row height.
    if (!this.rowMeasured && this.mounted.size) {
      const sample = this.mounted.values().next().value as HTMLElement;
      const measured = sample.offsetHeight;
      this.rowMeasured = measured > 0;
      if (this.rowMeasured && Math.abs(measured - this.rowHeight) > 0.5) {
        this.rowHeight = measured;
        this.invalidateRange();
        this.render();
      }
    }
  }

  private place(element: HTMLElement, position: number) {
    const column = position % this.columns;
    const row = Math.floor(position / this.columns);
    const x = column * (this.columnWidth + this.columnGap);
    const y = row * (this.rowHeight + this.rowGap);
    const key = `${x}|${y}|${this.columnWidth}`;
    if (this.positions.get(element) === key) return;
    this.positions.set(element, key);
    element.style.width = `${this.columnWidth}px`;
    element.style.transform = `translate(${x}px, ${y}px)`;
  }

  private reconcile(wanted: number[], firstPosition: number) {
    const { container } = this.options;
    const wantedSet = new Set(wanted);
    for (const [id, element] of this.mounted) {
      if (wantedSet.has(id)) continue;
      element.remove();
      this.mounted.delete(id);
      // Re-inserting moves the card to the most recently used end.
      this.cache.delete(id);
      this.cache.set(id, element);
    }

    const missing = wanted.filter((id) => !this.mounted.has(id) && !this.cache.has(id));
    if (missing.length) {
      this.options.create(missing).forEach((element, index) => this.cache.set(missing[index], element));
    }

    // Document order follows the grid, for keyboard and screen reader order.
    let cursor = container.firstElementChild;
    wanted.forEach((id, offset) => {
      let element = this.mounted.get(id);
      if (!element) {
        element = this.cache.get(id)!;
        this.cache.delete(id);
        this.mounted.set(id, element);
        this.options.update(element, id);
      }
      this.place(element, firstPosition + offset);
      if (element === cursor) cursor = cursor.nextElementSibling;
      else container.insertBefore(element, cursor);
    });

    for (const id of this.cache.keys()) {
      if (this.cache.size <= CACHE_LIMIT) break;
      this.cache.delete(id);
    }
  }
}
