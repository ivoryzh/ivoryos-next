"use client";
import React from 'react';
import { ChevronDown, ChevronRight, GitBranch, GripVertical, Hourglass, MessageSquareText, Repeat, StickyNote } from 'lucide-react';

/**
 * The pieces of a designer's toolbox, shared by the edge Designer (WorkflowEditor) and Cloud's
 * Orchestrator (CloudWorkflowEditor) so the two palettes read the same: a Logic group of built-in
 * steps, saved workflows, then each instrument's methods, every entry the same compact chip told
 * apart by its icon colour. What an entry does is in its tooltip, not on the chip.
 *
 * The two editors drag differently (a list via @hello-pangea/dnd on the edge, HTML5 drag onto a
 * React Flow canvas on Cloud), so a chip takes whatever drag props and ref its editor hands it.
 */

/**
 * The colour family of each kind of built-in step, used by the toolbox chip, the step card's pill,
 * its tint and its inline fields. Purple is deliberately absent: on a step it means "runs once per
 * batch" (as in the original IvoryOS), and nothing else may borrow it.
 */
const TONES = {
  sky: {
    accent: 'text-sky-500',
    pill: 'bg-sky-100 text-sky-700 border-sky-200 dark:bg-sky-500/15 dark:text-sky-300 dark:border-sky-500/25',
    card: 'bg-sky-50/50 dark:bg-sky-900/10',
    input: 'bg-sky-500/10 dark:bg-sky-900/40 border-sky-200 dark:border-sky-800/50 focus:border-sky-400 dark:focus:border-sky-500 text-sky-900 dark:text-sky-100 placeholder-sky-300 dark:placeholder-sky-600/50',
  },
  orange: {
    accent: 'text-orange-500',
    pill: 'bg-orange-100 text-orange-700 border-orange-200 dark:bg-orange-500/15 dark:text-orange-300 dark:border-orange-500/25',
    card: 'bg-orange-50/50 dark:bg-orange-900/10',
    input: 'bg-orange-500/10 dark:bg-orange-900/40 border-orange-200 dark:border-orange-800/50 focus:border-orange-400 dark:focus:border-orange-500 text-orange-900 dark:text-orange-100 placeholder-orange-300 dark:placeholder-orange-600/50',
  },
  teal: {
    accent: 'text-teal-500',
    pill: 'bg-teal-100 text-teal-700 border-teal-200 dark:bg-teal-500/15 dark:text-teal-300 dark:border-teal-500/25',
    card: 'bg-teal-50/50 dark:bg-teal-900/10',
    input: 'bg-teal-500/10 dark:bg-teal-900/40 border-teal-200 dark:border-teal-800/50 focus:border-teal-400 dark:focus:border-teal-500 text-teal-900 dark:text-teal-100 placeholder-teal-300 dark:placeholder-teal-600/50',
  },
  pink: {
    accent: 'text-pink-500',
    pill: 'bg-pink-100 text-pink-700 border-pink-200 dark:bg-pink-500/15 dark:text-pink-300 dark:border-pink-500/25',
    card: 'bg-pink-50/50 dark:bg-pink-900/10',
    input: 'bg-pink-500/10 dark:bg-pink-900/40 border-pink-200 dark:border-pink-800/50 focus:border-pink-400 dark:focus:border-pink-500 text-pink-900 dark:text-pink-100 placeholder-pink-300 dark:placeholder-pink-600/50',
  },
  slate: {
    accent: 'text-slate-400',
    pill: 'bg-slate-100 text-slate-600 border-slate-200 dark:bg-white/10 dark:text-slate-300 dark:border-white/10',
    card: 'bg-slate-50/60 dark:bg-slate-800/15',
    input: 'bg-slate-500/10 dark:bg-slate-800/40 border-slate-200 dark:border-slate-700/50 focus:border-slate-400 dark:focus:border-slate-500 text-slate-900 dark:text-slate-100 placeholder-slate-300 dark:placeholder-slate-600/50',
  },
} as const;

type Look = { label: string; icon: React.ComponentType<{ className?: string }> } & (typeof TONES)[keyof typeof TONES];
const look = (label: string, icon: Look['icon'], tone: keyof typeof TONES): Look => ({ label, icon, ...TONES[tone] });

/**
 * Each built-in step as it is stored and run (If, End_While, Sleep...), for the step card: the
 * pill it shows where an instrument step shows its instrument, its tint and its fields.
 */
const LOGIC_STEPS: Record<string, Look> = {
  If: look('If', GitBranch, 'sky'),
  Else: look('Else', GitBranch, 'sky'),
  End_If: look('End if', GitBranch, 'sky'),
  While: look('While', Repeat, 'orange'),
  End_While: look('End while', Repeat, 'orange'),
  Sleep: look('Wait', Hourglass, 'teal'),
  Wait: look('Wait', Hourglass, 'teal'),
  User_Input: look('User input', MessageSquareText, 'pink'),
  Comment: look('Comment', StickyNote, 'slate'),
};

/** How a built-in step looks on a card; a method this does not know gets the neutral look. */
export const logicStepLook = (method: string): Look => LOGIC_STEPS[method] || look(method.replace(/_/g, ' '), StickyNote, 'slate');

/**
 * How each built-in step looks in a palette and on Cloud's canvas, keyed by the method that is
 * dropped. The same colours as the cards above.
 */
export const LOGIC_TOOLS: Record<string, { label: string; icon: React.ComponentType<{ className?: string }>; accent: string }> = {
  // Cloud's Wait and the edge's Sleep are the same step under two names.
  Wait: { label: 'Wait', icon: Hourglass, accent: TONES.teal.accent },
  Sleep: { label: 'Wait', icon: Hourglass, accent: TONES.teal.accent },
  User_Input: { label: 'User input', icon: MessageSquareText, accent: TONES.pink.accent },
  // Cloud drops `If`; the edge drops `If_Else_Block`, which expands into If / Else / End_If.
  If: { label: 'If / else', icon: GitBranch, accent: TONES.sky.accent },
  If_Else_Block: { label: 'If / else', icon: GitBranch, accent: TONES.sky.accent },
  While_Loop: { label: 'While loop', icon: Repeat, accent: TONES.orange.accent },
  Comment: { label: 'Comment', icon: StickyNote, accent: TONES.slate.accent },
};

type ToolChipProps = {
  icon: React.ComponentType<{ className?: string }>;
  accent: string;
  label: string;
  trailing?: React.ReactNode;
  /** Being dragged: drawn solid, since it floats over the canvas. */
  dragging?: boolean;
  /** The copy left behind in the palette while the real one is dragged away. */
  ghost?: boolean;
} & Omit<React.HTMLAttributes<HTMLDivElement>, 'children'>;

/** One draggable entry. */
export const ToolChip = React.forwardRef<HTMLDivElement, ToolChipProps>(function ToolChip(
  { icon: Icon, accent, label, trailing, dragging = false, ghost = false, className = '', ...rest }, ref,
) {
  return (
    <div
      ref={ref}
      {...rest}
      className={`group flex items-center gap-2 rounded-lg border px-2.5 py-1.5 transition-colors ${ghost ? 'opacity-50 pointer-events-none select-none' : 'cursor-grab active:cursor-grabbing'} ${dragging
        ? 'border-gray-300 dark:border-white/20 bg-white shadow-xl ring-2 ring-accent-ring dark:border-white/30 dark:bg-[#1a1a1a]'
        : 'border-gray-300 bg-white shadow-sm hover:border-gray-400 hover:bg-gray-50 dark:shadow-none dark:border-white/10 dark:bg-white/[0.03] dark:hover:border-white/20 dark:hover:bg-white/[0.07]'} ${className}`}
    >
      <Icon className={`w-3.5 h-3.5 shrink-0 ${accent}`} />
      <span className="min-w-0 flex-1 truncate text-xs font-medium text-gray-700 dark:text-gray-200">{label}</span>
      {trailing}
      <GripVertical className="w-3.5 h-3.5 shrink-0 text-gray-300 opacity-0 group-hover:opacity-100 dark:text-gray-600" />
    </div>
  );
});

/** A foldable group's heading (Logic, a device, Instruments). */
export function ToolboxGroupHeader({ collapsed, onToggle, title, children }: {
  collapsed: boolean; onToggle: () => void; title?: string; children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      title={title}
      aria-expanded={!collapsed}
      className="w-full flex items-center gap-2 px-2 py-1 mb-1 rounded-md text-left hover:bg-black/5 dark:hover:bg-white/5"
    >
      {collapsed
        ? <ChevronRight className="w-3.5 h-3.5 shrink-0 text-gray-400" />
        : <ChevronDown className="w-3.5 h-3.5 shrink-0 text-gray-400" />}
      {children}
    </button>
  );
}

/** The heading text inside a ToolboxGroupHeader. */
export function ToolboxGroupTitle({ children }: { children: React.ReactNode }) {
  return <h3 className="text-sm font-bold text-gray-800 dark:text-gray-200 truncate">{children}</h3>;
}

/** A small uppercase label inside a group ("Workflows"). */
export const TOOLBOX_SUBLABEL = 'px-1 pt-1 text-[10px] font-semibold uppercase tracking-wider text-gray-400 dark:text-gray-500';

/**
 * One instrument's heading inside Instruments: its name in mono, its method count, foldable.
 * Open by default; the count shows when folded.
 */
export function ToolboxInstrumentHeader({ name, count, collapsed, onToggle }: {
  name: string; count: number; collapsed: boolean; onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={!collapsed}
      title={collapsed ? `Show ${name}'s ${count} methods` : `Fold ${name}`}
      className="w-full flex items-center gap-1 px-1 py-0.5 rounded text-left text-[11px] font-mono text-gray-500 hover:text-gray-800 dark:text-gray-400 dark:hover:text-gray-200"
    >
      {collapsed ? <ChevronRight className="w-3 h-3 shrink-0" /> : <ChevronDown className="w-3 h-3 shrink-0" />}
      <span className="truncate">{name}</span>
      <span className="ml-auto pl-2 font-sans text-[10px] text-gray-400 dark:text-gray-500">{count}</span>
    </button>
  );
}

/**
 * The `#auto` switch: dropped steps fill every field with `#<field name>`, ready for the
 * spreadsheet or the optimizer.
 */
export function AutoFillToggle({ on, onToggle, title }: { on: boolean; onToggle: () => void; title?: string }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={on}
      title={title ?? (on
        ? '#auto is on: dropped steps fill every field with #<field name>. Click to turn off.'
        : 'Turn on #auto: dropped steps fill every field with #<field name>, ready to configure.')}
      className={`shrink-0 px-2 py-0.5 rounded-md border font-mono text-[11px] font-semibold transition-colors ${on
        ? 'bg-accent border-accent text-on-accent'
        : 'bg-white border-gray-200 text-gray-500 hover:text-gray-800 dark:bg-white/5 dark:border-white/10 dark:text-gray-400 dark:hover:text-gray-200'}`}
    >
      #auto
    </button>
  );
}
