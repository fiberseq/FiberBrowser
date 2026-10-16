/** Reveal an element in its nearest vertical scroller without moving hidden-overflow panel ancestors. */
export function scrollIntoViewWithin(el: HTMLElement | null | undefined, opts: ScrollIntoViewOptions = {}) {
  if (!el) return;
  for (let parent = el.parentElement; parent; parent = parent.parentElement) {
    if (!/^(auto|scroll)$/.test(getComputedStyle(parent).overflowY)) continue;
    const rect = el.getBoundingClientRect();
    const top = rect.top - parent.getBoundingClientRect().top - parent.clientTop;
    const bottom = top + rect.height;
    const height = parent.clientHeight;
    const block = opts.block ?? 'start';
    let delta = top;
    if (block === 'center') delta = top - (height - rect.height) / 2;
    else if (block === 'end') delta = bottom - height;
    else if (block === 'nearest') {
      if ((top >= 0 && bottom <= height) || (top < 0 && bottom > height)) return;
      delta = top < 0 ? (rect.height <= height ? top : bottom - height)
        : (rect.height <= height ? bottom - height : top);
    }
    const scrollTop = Math.max(0, Math.min(parent.scrollHeight - height, parent.scrollTop + delta));
    if (opts.behavior === 'smooth' && parent.scrollTo) parent.scrollTo({ top: scrollTop, behavior: 'smooth' });
    else parent.scrollTop = scrollTop;
    return;
  }
}
