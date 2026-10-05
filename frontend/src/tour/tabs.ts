// Deck tabs in the tour, as iframes laid exactly where the desktop app lays a deck's
// WebContentsView (desktop/src/main.js layoutTabs): right of the launcher's sidebar, under its tab
// bar, one per open deck, only the active one showing. The launcher page draws the tab bar and
// reports its height and the sidebar's width, as it does in the app.
import type { Tabs } from '@/desktop';
import { DECK_FRAME_PREFIX, TOUR_BASE } from './lab';

export class TourTabs {
  private frames = new Map<string, HTMLIFrameElement>();
  private active: string | null = null;
  private tabBarHeight = 44;
  private sidebarWidth = 0;
  private host: HTMLDivElement | null = null;

  constructor(private readonly changed: (tabs: Tabs) => void) {}

  state(): Tabs {
    return { open: [...this.frames.keys()], active: this.active };
  }

  /** Open (or switch to) a deck's tab; `page` such as '/execution/' opens that page of it. */
  open(id: string, page?: string) {
    const target = `${TOUR_BASE}${page && /^\/[\w\-/]*$/.test(page) ? page : '/'}`;
    let frame = this.frames.get(id);
    if (!frame) {
      frame = document.createElement('iframe');
      frame.title = 'Deck';
      // Survives navigation inside the frame, so every page of this deck reaches its edge (install.ts).
      frame.name = `${DECK_FRAME_PREFIX}${id}`;
      frame.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;border:0;background:transparent';
      frame.src = target;
      this.ensureHost().appendChild(frame);
      this.frames.set(id, frame);
    } else if (page) {
      frame.src = target;
    }
    this.show(id);
  }

  show(id: string | null) {
    this.active = id && this.frames.has(id) ? id : null;
    this.layout();
    this.changed(this.state());
  }

  close(id: string) {
    const frame = this.frames.get(id);
    if (!frame) return;
    frame.remove();
    this.frames.delete(id);
    if (this.active === id) this.active = null;
    this.layout();
    this.changed(this.state());
  }

  reload() {
    const frame = this.active ? this.frames.get(this.active) : null;
    frame?.contentWindow?.location.reload();
  }

  /** A deck that came back from a restart: its open tab shows the edge as it is now (main.js reloadReturnedTabs). */
  reloadDeck(id: string) {
    this.frames.get(id)?.contentWindow?.location.reload();
  }

  setTabBarHeight(px: number) {
    this.tabBarHeight = Math.max(0, Math.round(Number(px) || 0));
    this.layout();
  }

  setSidebarWidth(px: number) {
    this.sidebarWidth = Math.max(0, Math.round(Number(px) || 0));
    this.layout();
  }

  private ensureHost(): HTMLDivElement {
    if (!this.host) {
      this.host = document.createElement('div');
      this.host.style.cssText = 'position:fixed;right:0;bottom:0;z-index:40;display:none';
      document.body.appendChild(this.host);
    }
    return this.host;
  }

  private layout() {
    const host = this.ensureHost();
    host.style.left = `${this.sidebarWidth}px`;
    host.style.top = `${this.tabBarHeight}px`;
    host.style.display = this.active ? 'block' : 'none';
    for (const [id, frame] of this.frames) frame.style.visibility = id === this.active ? 'visible' : 'hidden';
  }
}
