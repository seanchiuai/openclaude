---
name: ui-components
description: Vue 3 component architecture with shadcn-vue, Reka UI, Tailwind CSS, and design system conventions. Use when building new UI components, modifying existing views, working with the design system, fixing layout/styling issues, or implementing responsive designs. Covers component structure, slot patterns, Tailwind utilities, animation conventions, and accessibility. Do NOT use for state management logic (use state-management skill) or server API routes (use api-server skill).
---

# UI Components

Vue 3 component library built on Reka UI headless primitives with Tailwind CSS styling and a minimalist, monochrome design system.

## Stack

- **Framework**: Vue 3 + Nuxt 3 (auto-imports for composables, components, utilities)
- **Headless primitives**: Reka UI (`reka-ui`) -- all overlay/menu/label components wrap Reka UI
- **Styling**: Tailwind CSS 3 with `tailwindcss-animate`, `@tailwindcss/forms`, `@tailwindcss/typography`, `@tailwindcss/aspect-ratio`
- **Variants**: `class-variance-authority` (CVA) for component variant definitions
- **Class merging**: `cn()` from `~/utils/classnames` (clsx + tailwind-merge)
- **Icons**: `@nuxt/icon` with Lucide icons (`lucide:icon-name`) + custom AOX collection (`aox:icon-name`)
- **Color mode**: `@nuxtjs/color-mode` with `darkMode: 'class'`, storage key `aox-color-mode`
- **Rich text**: TipTap via `nuxt-tiptap-editor` (StarterKit + TaskList + TaskItem)
- **Animations**: GSAP (lazy-loaded chunk), `tailwindcss-animate`, CSS keyframes
- **Font**: Selecta (custom, WOFF2) as primary sans-serif
- **Native app**: Capacitor platform variants (`native:`, `native-ios:`, `native-android:`)

## Component Directory Map

```
components/
  common/              Shared UI primitives (70+ components)
    action-button/     ActionButton
    animated-logo/     AnimatedLogo
    avatar/            Avatar, AvatarFallback, AvatarImage (CVA: size, shape)
    bar-diagram/       BarDiagram
    card/              Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle
    chat-bubble/       ChatBubble (CVA: spark | user variants)
    chat-view/         ChatView
    content-layout/    ContentLayout
    dropdown-menu/     Full Reka UI DropdownMenu compound component (14 parts)
    empty-state/       EmptyState
    extended-container/ ExtendedContainer
    foldout-button/    FoldoutButton (CVA: inactive | active, with sub-options)
    generate-button/   GenerateButton
    header-input/      HeaderInput
    headline/          Headline
    hover-action-bar/  HoverActionBar
    icon-button/       IconButton (outline | ghost, shared sizing from sizes.ts)
    input/             MessageInput (main dual-textarea wrapper), MessageInputTextArea (auto-resize + voice overlay),
                       MessageInputButton (send button with two-stage animation), MessageInputSuggestions (horizontal carousel),
                       MessageInputAttachment (scrollable file/link/keyword container), Input (legacy with mentions, tags, toolbar),
                       InputFieldSimplified, InputSource, InputTag
    input-field/       InputField (CVA: inactive | active)
    label/             Label (wraps Reka UI Label)
    list-item/         ListItem, ListItemSimplified (CVA)
    navigation-button/ NavigationButton
    navigation-tabs/   NavigationTab, NavigationTabs
    progress-bar/      ProgressBar
    progress-line/     ProgressLine
    save-generate-button/ SaveGenerateButton
    section-label/     SectionLabel
    simple-button/     SimpleButton (CVA: inactive|active|plain|danger|mobileButton, size: default|xl|icon|chevron-icon)
    simple-card/       SimpleCard (CVA, with slots: header-right, floating)
    skeleton/          Skeleton (animate-pulse)
    spark-card-horizontal/ SparkCardHorizontal
    status-indicator/  StatusIndicator
    switcher-button/   SwitcherButton (CVA: inactive|active|plain)
    text-reveal/       TextReveal (animated placeholder cycling)
    textarea/          TextArea (CVA: inactive|active|plain, auto-resize)
    texteditor/        RichTextEditor (TipTap wrapper)
    toolbar/           Toolbar
    -- standalone files --
    AnimatedMessage.vue, BrandLoader.vue, ChatInput.vue, ContentPage.vue,
    CookieConsent.vue, DemoContent.vue, DocsViewer.vue, DropdownBackdrop.vue,
    DropdownHeader.vue, FeedbackButton.vue, GlobalTooltip.vue, GradientBackground.vue,
    Logo.vue, Modal.vue, ProfileAvatarStack.vue, ScrollMaskedContainer.vue,
    SeoContentPage.vue, SeoJsonLd.vue, SlideInActionButtons.vue, SparkAvatar.vue,
    SubInformation.vue, TalkToSection.vue, TiptapToolbar.vue, UpgradePromptBanner.vue
    -- shared config --
    index.ts           Barrel exports for frequently used components
    types.ts           Shared types (SidebarState, SlideInState, SparkItem, FlowItem, etc.)
    sizes.ts           ComponentSize system (xs|sm|base|lg) with COMPONENT_SIZES map

  workspace/           Main app workspace
    Workspace.vue      Root workspace layout (sidebar + chat + panels)
    WorkspaceSidebar.vue, WorkspaceChatView.vue, WorkspaceSlideIns.vue, WorkspaceLeftSlideIns.vue
    board/             ConceptBoard, IdeaCard, IdeaDetailPanel, ImageStickyNote, items/
    chat/              MessageStream
    panels/            SlideIn, SlideInWrapper, SlideInSettings, SlideInSparkInfo, SlideInShare, SlideInUserAccess, etc.
    sidebar/           SidebarContent, SidebarFlows, SidebarSparks, SidebarToolbar, etc.
    voice/             VoiceWaveform
    VoiceMode.vue      Voice mode (workspace root level)

  spark/               SparkCard, SparkGenerationLoader, SparkSettings, SparkToolbar, edit/
  flow/                FlowSettings, SparkProcess, SparkSelection, 3d/ (ContextNode, NodeWrapper, OptionsBar), sections/
  navigation/          Header, PublicHeader, ProfileDropdown, SettingsDropdown, MobileMenu, FooterLinks
  auth/                LoginDialog, RegisterDialog, MobileAuthDialog, NativeAuthContent
  settings/            analytics.vue, general.vue, preferences.vue, subscription.vue, team.vue, etc.
  graphs/              SphereGraph (Three.js/D3)
  public/landing/      LandingIntro, LandingPricing, LandingThinkingModel, LogoMarquee, etc.
  survey/              SurveyGraph, SurveySphere
```

## Design System

### Color Palette (HSL CSS Variables)

All semantic colors use HSL CSS variables defined in `assets/css/main.css`. Tailwind maps them via `tailwind.config.js`.

| Token | Light | Dark | Usage |
|---|---|---|---|
| `--background` | `0 0% 100%` (white) | `0 0% 0%` (black) | Page background |
| `--foreground` | `0 0% 3.9%` | `0 0% 98%` | Primary text |
| `--primary` | `0 0% 76%` | `0 0% 76%` | Brand primary (grey) |
| `--secondary` | `0 0% 96.1%` | `0 0% 14.9%` | Secondary surfaces |
| `--muted` | `0 0% 90%` | `0 0% 14.9%` | Muted backgrounds |
| `--accent` | `0 0% 96.1%` | `0 0% 14.9%` | Accent backgrounds |
| `--destructive` | `0 84.2% 60.2%` | `0 62.8% 30.6%` | Error/danger |
| `--border` | `0 0% 89.8%` | `0 0% 14.9%` | Default borders |
| `--border-subtle` | `0 0% 38.4%` | `0 0% 30%` | Subtle borders |
| `--active` | `0 0% 0%` (black) | `0 0% 30%` | Active state |
| `--border-grey` | `#000` | `#fff` | High contrast border |
| `--border-grey-light` | `#000` | `#fff` | Light contrast border |

Additional utility colors: `success` (green), `warning` (amber), `error` (red), `discipline-yellow`, `discipline-blue`, `text-grey` (#807F7F).

Dynamic colors via `composables/ui/useDynamicColors.ts`: generates random primary/secondary RGB colors with brightness constraints. Exports reactive `primaryColor` and `secondaryColor` refs.

### Typography

Font family: `Selecta` (400, 700, italic variants) loaded from `assets/css/font/`.

Key font sizes defined in `tailwind.config.js` with mobile overrides in `main.css`:

| Class | Desktop | Mobile (<768px) |
|---|---|---|
| `text-xs` | 12.5px / 15.6px | 11px / 13.2px |
| `text-sm` | 18px / 23.4px | 15px / 18px |
| `text-sm-uppercase` | 15.5px / 21.45px | 13px / 18.2px |
| `text-lg` | 28px / 28px | 22px / 22px |
| `text-5xl` | 3.3rem / 0.9 | 2.2rem / 1 |

Convention: use `text-mobile-sm md:text-sm` for responsive text, and `text-mobile-sm-uppercase md:text-sm-uppercase uppercase` for label/button text.

### Spacing and Sizing

- Global UI spacing: `--simplified-ui-spacing: 15px`
- Workspace padding: `p-[15px]` on all sides
- Custom spacing values: `13` (50.2px), `15` (60.8px), `18` (4.5rem), `88` (22rem), `128` (32rem)
- Border radius: `lg` = 1.5rem, `xl` = 2rem, `2xl` = 2.5rem (larger than default Tailwind)
- Shared component sizes via `components/common/sizes.ts`:
  - `xs`: 36px container, 14px icon
  - `sm`: 32px mobile / 44px desktop, 14px icon
  - `base`: 48px container, 16px icon
  - `lg`: 52px mobile / 60px desktop, 20px icon

### Dark Mode

Uses class-based dark mode (`darkMode: 'class'` in Tailwind). The `.dark` class on `<html>` toggles all `dark:` variants. GradientBackground component provides the page background with distinct light/dark gradients.

Pattern: Always provide both light and dark variants:
```html
<div class="bg-white/60 dark:bg-black/60 text-black dark:text-white">
```

## CVA Variant Pattern

Every component with visual variants uses CVA. The index.ts barrel file defines variants and exports both the component and the variant function.

```ts
// components/common/simple-button/index.ts
import type { VariantProps } from "class-variance-authority"
import { cva } from "class-variance-authority"

export { default as SimpleButton } from "./SimpleButton.vue"

export const simpleButtonVariants = cva(
  "inline-flex items-center justify-center px-6 md:px-7 py-4 md:py-5 rounded-xl transition-all duration-300 ease-in-out whitespace-nowrap",
  {
    variants: {
      variant: {
        inactive: "font-normal hover:font-bold shadow-[inset_0_0_0_1px_#626262] bg-white/60 dark:bg-black/60 backdrop-blur-md text-black dark:text-white",
        active: "font-bold shadow-[inset_0_0_0_2px_black] dark:shadow-[inset_0_0_0_2px_white] bg-white/60 dark:bg-black/60 backdrop-blur-md text-black dark:text-white",
      },
      size: { default: "", xl: "px-8 md:px-10 py-5 md:py-6", icon: "!p-0 h-13 md:h-15 w-13 md:w-15 rounded-full" },
    },
    compoundVariants: [
      { variant: "inactive", size: "icon", class: "[&_svg]:stroke-[0.1] hover:[&_svg]:stroke-[0.6]" },
    ],
    defaultVariants: { variant: "inactive", size: "default" },
  },
)
export type SimpleButtonVariants = VariantProps<typeof simpleButtonVariants>
```

Usage in component:
```vue
<Primitive :class="cn(simpleButtonVariants({ variant, size }), props.class)">
```

Design language: Components use `shadow-[inset_0_0_0_1px_#626262]` for inactive borders, `shadow-[inset_0_0_0_2px_black] dark:shadow-[inset_0_0_0_2px_white]` for active borders, and `bg-white/60 dark:bg-black/60 backdrop-blur-md` for glassmorphism surfaces.

## Component Patterns

### Props, Emits, Slots

```vue
<script setup lang="ts">
import type { HTMLAttributes } from "vue"
import { cn } from "~/utils/classnames"

interface Props {
  variant?: 'inactive' | 'active'
  size?: ComponentSize
  class?: HTMLAttributes["class"]       // Accept class prop for cn() merging
}
const props = withDefaults(defineProps<Props>(), {
  variant: 'inactive',
  size: 'sm',
})

const emit = defineEmits<{
  close: []                              // Tuple syntax preferred
  'update:modelValue': [value: string]
}>()
</script>
```

### Reka UI Wrappers (Dropdown, Label, etc.)

Components in `common/dropdown-menu/` wrap Reka UI primitives with styled defaults:

```vue
<script setup lang="ts">
import type { DropdownMenuContentProps } from "reka-ui"
import { DropdownMenuContent, DropdownMenuPortal, useForwardPropsEmits } from "reka-ui"
import { cn } from "~/utils/classnames"

const props = withDefaults(defineProps<DropdownMenuContentProps & { class?: HTMLAttributes["class"] }>(), {
  sideOffset: 4,
  align: "start",
})
const forwarded = useForwardPropsEmits(reactiveOmit(props, "class"), emits)
</script>
<template>
  <DropdownMenuPortal>
    <DropdownMenuContent v-bind="forwarded" :class="cn('z-50 rounded-xl border border-border-subtle backdrop-blur-xl bg-background/80 ...', props.class)">
      <slot />
    </DropdownMenuContent>
  </DropdownMenuPortal>
</template>
```

### Modal / Dialog Pattern

The app uses a custom `Modal.vue` component (not Reka UI Dialog):

```vue
<Modal title="Edit Spark" max-width="lg" @close="showModal = false">
  <template #headerActions>...</template>
  <!-- Body content -->
  <template #actions>
    <SimpleButton @click="save">Save</SimpleButton>
  </template>
</Modal>
```

Auth dialogs (LoginDialog, RegisterDialog) use Teleport to body with custom backdrop and transitions. They can also be embedded inline within `SlideInUserAccess` for the workspace user access panel.

### SlideInUserAccess Panel

`SlideInUserAccess.vue` embeds LoginDialog/RegisterDialog inline as a left slide-in panel with login/register tab navigation. Displays an optional contextual message from `panelsStore.userAccessMessage`. Managed via `panelsStore.openUserAccess(message?)` / `panelsStore.closeUserAccess()`.

### UpgradePromptBanner

`UpgradePromptBanner.vue` displays a contextual upgrade message using `SubInformation` with `variant="gradient"` (orange-to-green gradient text). Shown in `SlideInSettings` on the subscription tab when `upgradePromptMessage` (from `useUpgradePrompt`) is set. Used for plan limit alerts and milestone-based nudges.

### SubInformation Variants

`SubInformation.vue` supports four variants: `default` (grey text), `warning` (red), `plain` (foreground), `gradient` (orange-to-green gradient via CSS `background-clip: text`).

### SlideIn Panel Pattern

Workspace panels use `SlideIn.vue` + `SlideInWrapper.vue`:
- `SlideIn`: Handles animation, positioning (left/right), mobile fullscreen
- `SlideInWrapper`: Provides standard panel layout (header with avatar, close button, navigation slot, content, footer)

```vue
<SlideIn :is-visible="isOpen" direction="right" :width="450" panel-id="spark-info">
  <SlideInWrapper title="Spark Info" show-close @close="close">
    <template #navigation>...</template>
    <!-- Content -->
  </SlideInWrapper>
</SlideIn>
```

## Icon System

Two icon sources available via `@nuxt/icon` (inline SVG mode):

1. **Lucide icons**: `<Icon name="lucide:arrow-right" class="size-4" />`
2. **Custom AOX icons**: `<Icon name="aox:chat" class="size-4" />` -- SVGs in `assets/icons/`

Available AOX icons: `at`, `board`, `chat`, `chats`, `close`, `connect`, `file`, `filter`, `keyword`, `keywords`, `link`, `logout`, `mail`, `minds`, `multiselect`, `new`, `plus`, `publish`, `search`, `share`, `trash`, `whatsapp`.

Icon stroke styling (from `main.css`): SVG strokes default to 1px, increase to 1.5px on hover. Global `--icon-stroke-width: 1.5px` CSS variable.

## Animation Patterns

### CSS Transitions (primary approach)
Most components use Tailwind transition utilities:
```html
<div class="transition-all duration-300 ease-in-out">
```
Standard durations: `duration-short` (300ms), `duration-medium` (500ms), `duration-long` (600ms), `duration-x-long` (1000ms). Easing: `ease-smooth` = `cubic-bezier(0.4, 0, 0.2, 1)`.

### CSS Keyframes
SimpleButton has `animated-button` keyframe (scale 0.7 to 1, 600ms). Card has `cardFade` pulse. Skeleton uses Tailwind `animate-pulse`. SparkAvatar uses `rotate-gradient` for animated border.

### GSAP (landing page only)
Used in `LandingThinkingModel.vue` for complex timeline animations. GSAP is chunk-split for lazy loading. Not used in workspace UI.

### Vue Transitions
Auth dialogs use `<Transition name="backdrop">` and `<Transition name="dialog">` with fade/slide effects.

## TipTap Rich Text Editor

`components/common/texteditor/RichTextEditor.vue` wraps TipTap with:
- StarterKit (headings h1-h3, lists, code blocks)
- TaskList + TaskItem extensions
- Custom ProseMirror-to-Markdown serializer
- `TiptapToolbar.vue` for formatting controls
- v-model via `update:modelValue` emitting Markdown strings
- Prose styling via `@tailwindcss/typography` with dark mode overrides

## i18n in Components

`useI18n()` is auto-imported by Nuxt. Use `$t()` in templates or `t()` in script:

```vue
<script setup lang="ts">
const { t } = useI18n()
</script>
<template>
  <span>{{ $t('chat.inputPlaceholder') }}</span>
</template>
```

Locale files: `locales/de.json`, `locales/en.json`, `locales/es.json`, `locales/fr.json`, `locales/zh.json`. When adding keys, update ALL five files.

## Responsive Design

Mobile breakpoint: `768px` (md). Detected via `composables/ui/useMobile.ts` (`isMobile` ref) and Tailwind `md:` prefix.

Patterns:
- Sizing: `size-8 md:size-11`, `px-6 md:px-7 py-4 md:py-5`
- Typography: `text-mobile-sm md:text-sm`, `text-mobile-sm-uppercase md:text-sm-uppercase uppercase`
- Layout: `hidden md:flex` / `flex md:hidden` for mobile/desktop switching
- Native app: `native:pt-[env(safe-area-inset-top)]` for Capacitor safe areas
- Touch targets: min 44px on mobile (Apple HIG) via native app CSS rules

## Form Patterns

- `InputField` (CVA): styled text input with inactive/active border states
- `TextArea` (CVA): auto-resizing textarea with animated placeholder, max 3 lines
- `ChatInput`: complex chat input with file attachments, voice recording, mode switcher, avatar
- `MessageInput`: New 5-component dual-textarea architecture: `MessageInput.vue` (orchestrator), `MessageInputTextArea.vue` (×2 instances, auto-resize + voice overlay + animated placeholder), `MessageInputButton.vue` (send button with width expansion then opacity fade animation), `MessageInputSuggestions.vue` (horizontal scrollable suggestions/sparks carousel), `MessageInputAttachment.vue` (file/link/keyword container with dynamic height). Used by `ChatView.vue` (replaced `Input`). Supports `mode` transitions between existing-chat and new-chat modes.
- `Input`: legacy input with contenteditable, @mention system, tag toolbar, source attachments. Now supports `multiple` file input and i18n-driven placeholders (`input.placeholderExamples.*` keys).
- Global form classes: `.form-input`, `.form-label`, `.form-error` in `main.css`
- Validation: inline error messages, disabled states via `opacity-40 pointer-events-none`

## Pinia Stores (UI-related)

```
stores/
  layout.ts    Sidebar state, mobile detection, active nav
  panels.ts    SlideIn panel open/close coordination
  tooltip.ts   Global tooltip positioning and visibility
  sparks.ts    Spark data and selection state
  flow.ts      Active flow state
  messages.ts  Chat messages
  settings.ts  User settings
  workspace.ts Workspace-level state
```

## UI Composables

```
composables/ui/
  useAnimatedPlaceholder.ts  Cycling text placeholder animation logic
  useBoardDragDrop.ts        Drag-and-drop for concept board
  useDropdownBlur.ts         Dropdown close-on-blur behavior
  useDynamicColors.ts        Dynamic primary/secondary color generation
  useDynamicGrid.ts          Responsive grid layout calculations
  useGlobalTooltip.ts        Global tooltip positioning
  useImageUrl.ts             Image URL normalization and thumbnails
  useLanguage.ts             Language/locale management
  useMobile.ts               Mobile breakpoint detection (768px)
  useMobileSwipe.ts          Swipe gesture for sidebar open/close
  usePlanLimits.ts           Feature gating by subscription plan
  useProgressAnimation.ts    Progress bar animation
  useScrollBehavior.ts       Scroll position management
  useSidebarToolbar.ts       Sidebar toolbar state
  useSlideInCoordinator.ts   Multiple slide-in panel coordination
  useTypewriter.ts           Typewriter text effect
  useUserContext.ts          User context for components
  useUserProfile.ts          User profile data management
  useVersion.ts              App version display
  useWebViewDetection.ts     Native webview detection
```

## Rules and Conventions

- **Max 200-300 lines per file** -- split into sub-components when exceeded
- **Modularize** -- extract reusable patterns into components or composables
- **No emojis** unless user explicitly requests them
- **All locale keys** must be added to all 5 locale files (de, en, es, fr, zh)
- **Use `cn()`** from `~/utils/classnames` for class merging (NOT `~/lib/utils`)
- **Import from barrel files** where available: `import { SimpleButton } from '~/components/common/simple-button'`
- **No `any` types** unless absolutely necessary -- define interfaces for all props and state
- **Never run dev server** -- one is always running
- **Native variants**: use `native:`, `native-ios:`, `native-android:` Tailwind variants for Capacitor-specific styles
- **Glassmorphism surfaces**: `bg-white/60 dark:bg-black/60 backdrop-blur-md`
- **Inset border pattern**: use `shadow-[inset_0_0_0_1px_#626262]` instead of `border` for the design system's border style

## Related Files

- `tailwind.config.js` -- Tailwind theme (colors, spacing, fonts, plugins, native variants)
- `assets/css/main.css` -- Global CSS: font-face, CSS variables, base/component/utility layers, native app styles, citation styles
- `assets/css/font/` -- Selecta font files (woff2, woff)
- `assets/icons/` -- Custom AOX SVG icon collection (18 icons)
- `utils/classnames.ts` -- `cn()` utility (clsx + tailwind-merge)
- `components/common/sizes.ts` -- Shared ComponentSize system and COMPONENT_SIZES map
- `components/common/types.ts` -- Shared types (SidebarState, SlideInState, SparkItem, etc.)
- `components/common/index.ts` -- Barrel exports for common standalone components
- `locales/` -- i18n translation files (de.json, en.json, es.json, fr.json, zh.json)
- `composables/ui/` -- All UI-related composables
- `stores/layout.ts` -- Layout store (sidebar, mobile state)
- `stores/panels.ts` -- Panel coordination store
- `nuxt.config.ts` -- Icon config (aox prefix), color-mode config, TipTap module, component auto-import
