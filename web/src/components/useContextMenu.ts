import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { closeOtherContextMenus, menuBus } from "../lib/menuBus";
import { useClampedMenuPosition } from "../lib/menuPosition";

/** Floating context menu state, clamped to the viewport and closed by an outside click, a contextmenu elsewhere,
 *  or another menu opening. */
export function useContextMenu<T extends { x: number; y: number }>(touchOpenedAt?: RefObject<number>) {
  const [menu, setMenu] = useState<T | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  useClampedMenuPosition(menu, menuRef, setMenu);

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const onClick = (e: MouseEvent) => {
      if (menuRef.current?.contains(e.target as Node)) return;
      if (touchOpenedAt && Date.now() - touchOpenedAt.current < 500) return;
      close();
    };
    const onContextMenu = touchOpenedAt ? onClick : close;
    // A discrete contextmenu can flush this effect before it finishes bubbling.
    // Clicks are safe to observe immediately, but defer that one listener.
    document.addEventListener("click", onClick);
    const contextMenuListenerTimer = window.setTimeout(
      () => document.addEventListener("contextmenu", onContextMenu),
      0,
    );
    menuBus.addEventListener("close", close);
    return () => {
      window.clearTimeout(contextMenuListenerTimer);
      document.removeEventListener("click", onClick);
      document.removeEventListener("contextmenu", onContextMenu);
      menuBus.removeEventListener("close", close);
    };
  }, [menu, touchOpenedAt]);

  const openMenu = useCallback((next: T) => {
    closeOtherContextMenus();
    setMenu(next);
  }, []);
  const closeMenu = useCallback(() => setMenu(null), []);

  return { menu, menuRef, openMenu, closeMenu };
}
