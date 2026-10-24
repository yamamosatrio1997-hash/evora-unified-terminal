import { CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import type { CharacterDef } from '../config/roster';

interface Entry {
  anchor: CSS2DObject;
  bubble: HTMLDivElement;
  text: HTMLSpanElement;
  active: { full: string; elapsed: number; duration: number } | null;
}

/**
 * Name tags and pop-up chat bubbles, rendered as HTML over the 3D scene.
 * Typing progress uses animation time, so it pauses with the simulation.
 */
export class BubbleLayer {
  onLine: (def: CharacterDef, text: string) => void = () => {};
  private readonly entries = new Map<string, Entry>();
  private readonly defs = new Map<string, CharacterDef>();

  /** Creates the tag/bubble anchor for a character; add the returned object to its root. */
  attach(def: CharacterDef, height: number): CSS2DObject {
    const el = document.createElement('div');
    el.className = `agent-tag role-${def.role}`;
    el.style.setProperty('--accent', def.role === 'lead' ? def.look.shirt : def.look.accent);
    const bubble = document.createElement('div');
    bubble.className = 'bubble';
    const who = document.createElement('b');
    who.textContent = def.name;
    const text = document.createElement('span');
    bubble.append(who, text);
    const tag = document.createElement('div');
    tag.className = 'nametag';
    tag.textContent = def.name;
    if (def.role !== 'trader') {
      const small = document.createElement('small');
      small.textContent = def.department ?? def.title;
      tag.append(small);
    }
    el.append(bubble, tag);

    const anchor = new CSS2DObject(el);
    anchor.center.set(0.5, 1);
    anchor.position.y = height + 0.15;
    this.entries.set(def.id, { anchor, bubble, text, active: null });
    this.defs.set(def.id, def);
    return anchor;
  }

  setHeight(id: string, height: number): void {
    const e = this.entries.get(id);
    if (e) e.anchor.position.y = height + 0.15;
  }

  setVisible(id: string, visible: boolean): void {
    const e = this.entries.get(id);
    if (e) e.anchor.visible = visible;
  }

  show(id: string, text: string, duration: number): void {
    const e = this.entries.get(id);
    if (!e) return;
    e.active = { full: text, elapsed: 0, duration };
    e.text.textContent = '';
    e.bubble.classList.add('show');
    e.anchor.element.classList.add('speaking');
    this.onLine(this.defs.get(id)!, text);
  }

  update(dt: number): void {
    for (const e of this.entries.values()) {
      const a = e.active;
      if (!a) continue;
      a.elapsed += dt;
      const chars = Math.min(a.full.length, Math.ceil(a.elapsed * 48));
      if (e.text.textContent!.length !== chars) e.text.textContent = a.full.slice(0, chars);
      if (a.elapsed >= a.duration) {
        e.active = null;
        e.bubble.classList.remove('show');
        e.anchor.element.classList.remove('speaking');
      }
    }
  }
}

/** Seconds a line stays on screen. */
export const speechDuration = (text: string): number => Math.min(7, Math.max(2.2, 1.4 + text.length * 0.055));
