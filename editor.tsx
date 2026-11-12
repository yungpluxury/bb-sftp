import { useEffect, useRef } from "react";
import { basicSetup } from "codemirror";
import { indentWithTab } from "@codemirror/commands";
import { Compartment, EditorState, Prec, type Extension } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { HighlightStyle, StreamLanguage, syntaxHighlighting } from "@codemirror/language";
import { tags, type Tag } from "@lezer/highlight";
import { css } from "@codemirror/lang-css";
import { html } from "@codemirror/lang-html";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { php } from "@codemirror/lang-php";
import { python } from "@codemirror/lang-python";
import { sql } from "@codemirror/lang-sql";
import { xml } from "@codemirror/lang-xml";
import { yaml } from "@codemirror/lang-yaml";
import { dockerFile } from "@codemirror/legacy-modes/mode/dockerfile";
import { nginx } from "@codemirror/legacy-modes/mode/nginx";
import { properties } from "@codemirror/legacy-modes/mode/properties";
import { shell } from "@codemirror/legacy-modes/mode/shell";
import { experimental_useCodeTheme, type PluginCodeThemeData } from "@get-bb/plugin-sdk/app";

export function languageFor(path: string): Extension {
  const name = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
  const ext = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1) : "";
  if (name === "dockerfile" || name.startsWith("dockerfile.")) return StreamLanguage.define(dockerFile);
  if (name === ".env" || name.startsWith(".env.") || ["ini", "conf", "cnf", "properties"].includes(ext)) {
    return path.includes("nginx") ? StreamLanguage.define(nginx) : StreamLanguage.define(properties);
  }
  if (["sh", "bash", "zsh"].includes(ext) || [".bashrc", ".profile", ".bash_profile", ".zshrc", ".bash_logout"].includes(name)) {
    return StreamLanguage.define(shell);
  }
  switch (ext) {
    case "php":
      return php();
    case "js":
    case "mjs":
    case "cjs":
    case "jsx":
      return javascript({ jsx: true });
    case "ts":
    case "mts":
    case "cts":
    case "tsx":
      return javascript({ typescript: true, jsx: ext === "tsx" });
    case "json":
    case "lock":
      return json();
    case "css":
    case "scss":
    case "less":
      return css();
    case "html":
    case "htm":
    case "vue":
      return html();
    case "md":
    case "markdown":
      return markdown();
    case "yml":
    case "yaml":
      return yaml();
    case "sql":
      return sql();
    case "py":
      return python();
    case "xml":
    case "svg":
      return xml();
    default:
      return [];
  }
}

const TOKEN_SCOPES: [Tag | readonly Tag[], string[]][] = [
  [tags.comment, ["comment"]],
  [[tags.string, tags.special(tags.string), tags.regexp], ["string"]],
  [[tags.number, tags.bool, tags.null, tags.atom], ["constant.numeric", "constant.language", "constant"]],
  [[tags.keyword, tags.controlKeyword, tags.moduleKeyword, tags.operatorKeyword], ["keyword.control", "keyword"]],
  [[tags.definitionKeyword, tags.modifier], ["storage.type", "storage", "keyword"]],
  [tags.operator, ["keyword.operator", "keyword"]],
  [[tags.function(tags.variableName), tags.function(tags.propertyName)], ["entity.name.function", "support.function"]],
  [[tags.typeName, tags.className, tags.namespace], ["entity.name.type", "entity.name.class", "support.type", "support.class"]],
  [tags.tagName, ["entity.name.tag"]],
  [tags.attributeName, ["entity.other.attribute-name"]],
  [tags.propertyName, ["variable.other.property", "support.type.property-name", "meta.object-literal.key", "variable"]],
  [[tags.variableName, tags.self], ["variable.other", "variable"]],
  [tags.heading, ["markup.heading", "entity.name.section"]],
  [tags.link, ["markup.underline.link", "string.other.link"]],
  [tags.invalid, ["invalid"]],
];

function ruleScopes(scope: string | readonly string[] | undefined): string[] {
  if (scope === undefined) return [];
  return (typeof scope === "string" ? scope.split(",") : [...scope]).map((s) => s.trim());
}

function colorFor(theme: PluginCodeThemeData, candidates: string[]): string | undefined {
  for (const candidate of candidates) {
    let best: { length: number; color: string } | null = null;
    for (const rule of theme.tokenColors) {
      const color = rule.settings.foreground;
      if (color === undefined) continue;
      for (const scope of ruleScopes(rule.scope)) {
        if (scope.includes(" ")) continue;
        if ((candidate === scope || candidate.startsWith(`${scope}.`)) && scope.length > (best?.length ?? -1)) {
          best = { length: scope.length, color };
        }
      }
    }
    if (best !== null) return best.color;
  }
  return undefined;
}

function themeExtension(theme: PluginCodeThemeData | null): Extension {
  if (theme === null) return [];
  const c = theme.colors;
  const highlight = HighlightStyle.define(
    TOKEN_SCOPES.flatMap(([tag, scopes]) => {
      const color = colorFor(theme, scopes);
      return color === undefined ? [] : [{ tag, color }];
    }),
  );
  return [
    EditorView.theme(
      {
        "&": { color: theme.fg, backgroundColor: "transparent", height: "100%" },
        ".cm-scroller": { fontFamily: "inherit", lineHeight: "1.25rem" },
        ".cm-content": { caretColor: c["editorCursor.foreground"] ?? theme.fg },
        ".cm-cursor, .cm-dropCursor": { borderLeftColor: c["editorCursor.foreground"] ?? theme.fg },
        ".cm-gutters": {
          backgroundColor: "transparent",
          color: c["editorLineNumber.foreground"] ?? "inherit",
          border: "none",
        },
        ".cm-activeLine": { backgroundColor: c["editor.lineHighlightBackground"] ?? "transparent" },
        ".cm-activeLineGutter": {
          backgroundColor: "transparent",
          color: c["editorLineNumber.activeForeground"] ?? theme.fg,
        },
        "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection": {
          backgroundColor: c["editor.selectionBackground"] ?? "rgba(128,128,128,0.3)",
        },
        "&.cm-focused": { outline: "none" },
      },
      { dark: theme.type === "dark" },
    ),
    syntaxHighlighting(highlight),
  ];
}

export function CodeEditor({
  path,
  initialValue,
  onChange,
  onSave,
}: {
  path: string;
  initialValue: string;
  onChange: (value: string) => void;
  onSave: () => void;
}) {
  const parent = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const themeSlot = useRef(new Compartment());
  const callbacks = useRef({ onChange, onSave });
  callbacks.current = { onChange, onSave };
  const { theme } = experimental_useCodeTheme();
  const initialTheme = useRef(theme);

  useEffect(() => {
    const editor = new EditorView({
      parent: parent.current!,
      state: EditorState.create({
        doc: initialValue,
        extensions: [
          Prec.highest(
            keymap.of([
              {
                key: "Mod-s",
                preventDefault: true,
                run: () => {
                  callbacks.current.onSave();
                  return true;
                },
              },
            ]),
          ),
          basicSetup,
          keymap.of([indentWithTab]),
          languageFor(path),
          themeSlot.current.of(themeExtension(initialTheme.current)),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) callbacks.current.onChange(update.state.doc.toString());
          }),
        ],
      }),
    });
    view.current = editor;
    editor.focus();
    return () => {
      editor.destroy();
      view.current = null;
    };
  }, [path, initialValue]);

  useEffect(() => {
    view.current?.dispatch({ effects: themeSlot.current.reconfigure(themeExtension(theme)) });
  }, [theme]);

  return <div ref={parent} className="h-full font-mono text-xs" />;
}
