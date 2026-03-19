import {
  cancel,
  confirm,
  intro,
  isCancel,
  multiselect,
  note,
  outro,
  select,
  spinner,
  text,
} from "@clack/prompts";
import type { WizardProgress, WizardPrompter } from "./prompts.js";
import { WizardCancelledError } from "./prompts.js";

function guardCancel<T>(value: T | symbol): T {
  if (isCancel(value)) {
    cancel("Setup cancelled.");
    throw new WizardCancelledError();
  }
  return value;
}

export function createClackPrompter(): WizardPrompter {
  return {
    intro: async (title) => {
      intro(title);
    },
    outro: async (message) => {
      outro(message);
    },
    note: async (message, title) => {
      note(message, title);
    },
    select: async (params) =>
      guardCancel(
        await select({
          message: params.message,
          options: params.options.map((opt) => ({
            value: opt.value,
            label: opt.label,
            hint: opt.hint,
          })),
          initialValue: params.initialValue,
        }),
      ),
    multiselect: async (params) =>
      guardCancel(
        await multiselect({
          message: params.message,
          options: params.options.map((opt) => ({
            value: opt.value,
            label: opt.label,
            hint: opt.hint,
          })),
          initialValues: params.initialValues,
        }),
      ),
    text: async (params) =>
      guardCancel(
        await text({
          message: params.message,
          initialValue: params.initialValue,
          placeholder: params.placeholder,
          validate: params.validate
            ? (value) => params.validate!(value ?? "")
            : undefined,
        }),
      ),
    confirm: async (params) =>
      guardCancel(
        await confirm({
          message: params.message,
          initialValue: params.initialValue,
        }),
      ),
    progress: (label: string): WizardProgress => {
      const spin = spinner();
      spin.start(label);
      return {
        update: (message) => {
          spin.message(message);
        },
        stop: (message) => {
          spin.stop(message);
        },
      };
    },
  };
}
