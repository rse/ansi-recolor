
# ansi-recolor(1) -- Transform ANSI Color Sequences of TUI Applications

## SYNOPSIS

`ansi-recolor`
\[`-h`|`--help`\]
\[`-V`|`--version`\]
\[`-c`|`--config` *config-file*\]
\[`-n`|`--name` *config-section*\]
\[`-m`|`--map`\]
\[`-t`|`--trace` *trace-file*\]
\[`-w`|`--watch`\]
\[`--`\]
\[*command* \[*args* \[...\]\]\]

## DESCRIPTION

`ansi-recolor`, *Transform ANSI Color Sequences of TUI Applications*,
is a small command-line tool to intercept and transform the ANSI
Select Graphic Rendition (SGR) color escape sequences emitted by
Terminal User Interface (TUI) applications. It spawns the target
*command* inside a Pseudo-Terminal (PTY), intercepts the output byte stream,
rewrites foreground and background colors according to a declarative
configuration file, and writes the transformed output to the real
terminal.

This allows the end-user to adjust or completely remap the color
palette of any terminal application without modifying the application
itself. It supports the ANSI basic 8 colors, bright 8 colors, the
256-color palette, and RGB/truecolor -- including optional pre-mapping
of RGB/truecolor to the nearest 256-color palette entry for easier
mapping of RGB/truecolor colors.

## OPTIONS

The following command-line options and arguments exist:

- \[`-h`|`--help`\]:
  Show program usage information only.

- \[`-V`|`--version`\]:
  Show program version information only.

- \[`-c`|`--config` *config-file*\]:
  Use *config-file* for the color mapping configuration.
  The default is `~/.ansi-recolor.conf` (in the user's home directory).

- \[`-n`|`--name` *config-section*\]:
  Use the section named *config-section* from the configuration file.
  The default is `default`.

- \[`-m`|`--map`\]:
  Pre-map RGB/truecolor values to the nearest ANSI 256-color palette
  entry before applying the color mapping rules. This is useful when the
  target application emits RGB/truecolor sequences but the mapping rules
  should still be written for the 256-color palette only.

- \[`-t`|`--trace` *trace-file*\]:
  Write a trace of all unique foreground/background color pairs
  encountered during execution to *trace-file*. The output uses the same
  syntax as the configuration file and can serve as a starting point for
  writing mapping rules. When `--trace` is given without `--config`,
  no color mapping is performed and the application output is just
  passed-through unmodified (except for the color tracking).

- \[`-w`|`--watch`\]:
  Watch the trace file specified by `--trace` and continuously print
  its content to standard output with inline color preview swatches.
  This mode does not accept a *command* and is intended to be run in a
  separate terminal alongside the main `ansi-recolor` invocation. This
  option requires `--trace`.

- *command* \[*args* \[...\]\]:
  The target application to spawn inside the PTY, followed by its
  optional arguments. Use `--` to separate `ansi-recolor` options
  from the target command if the command starts with a hyphen.

## CONFIGURATION

The configuration file of `ansi-recolor` uses a simple line-oriented
format consisting of color aliases, section headers, and mapping rules.
Blank lines and lines starting with `#` (comments) are ignored.

The configuration file has to match the following PEG-style grammar:

```txt
<config>        ::= (<empty-line> | <comment> | <alias> | <section>)*

<empty-line>    ::= /\s*\r?\n/
<comment>       ::= /\s*#.*?\r?\n/
<alias>         ::= <name> "=" <color>
<section>       ::= <section-head> <mapping>+

<section-head>  ::= <name> ":"
<mapping>       ::= /\s+/ <color-pair> "->" <color-pair>

<color-pair>    ::= <color> "/" <color>

<color>         ::= <modifier>? <color-value>
<modifier>      ::= "!" | "-"
<color-value>   ::= "*" | "default" | <basic> | <bright>
                    | <index-256> | <hex-rgb> | <name>

<basic>         ::= "black" | "red" | "green" | "yellow"
                    | "blue" | "magenta" | "cyan" | "white"
<bright>        ::= "bright-" <basic>
<index-256>     ::= /[0-9]{1,3}/
<hex-rgb>       ::= "#" /[0-9a-fA-F]{3}/ | "#" /[0-9a-fA-F]{6}/
<name>          ::= /[a-zA-Z][a-zA-Z0-9_-]*/
```

The configuration structure and semantics are:

- **Color Aliases** are defined as non-indented lines of the form
  `<name> = <color>` and provide symbolic names for color values.
  Aliases are global across all sections and can reference other
  aliases. They must be defined before use.

- **Sections** start with a non-indented section name followed by a
  colon (e.g. `default:`). Each section contains one or more indented
  mapping rules. The section name is selected at runtime via the
  `-n`|`--name` option.

- **Mapping Rules** are indented lines of the form
  `<fg>/<bg> -> <fg>/<bg>`, where the left side is the source color
  pair to match and the right side is the replacement color pair.
  All matching rules are applied in order (last-match-wins strategy),
  with later rules overriding earlier ones.

The following color value types are supported:

- `*` (wildcard): On the source side, matches any color. On the target
  side, means "keep the current value" (pass-through unchanged).

- `default`: The terminal's default foreground or background color
  (SGR 39 / SGR 49).

- Basic color names: `black`, `red`, `green`, `yellow`, `blue`,
  `magenta`, `cyan`, `white` (SGR 30-37 / SGR 40-47).

- Bright color names: `bright-black`, `bright-red`, `bright-green`,
  `bright-yellow`, `bright-blue`, `bright-magenta`, `bright-cyan`,
  `bright-white` (SGR 90-97 / SGR 100-107).

- 256-color index: A decimal number `0`-`255` (SGR 38;5;N / SGR 48;5;N).

- Hex RGB: `#RGB` (short) or `#RRGGBB` (long) hex notation
  (SGR 38;2;R;G;B / SGR 48;2;R;G;B).

- Named alias: A previously defined alias name.

The following color modifiers are supported on both source and target side:

- `-` (dim/faint suffix): Activate the dim/faint text attribute
  (SGR 2) together with the color. On the source side, the `-`
  suffix requires that the dim/faint attribute is currently active
  for the rule to match.

The following color modifiers are supported on the target side:

- `!` (style-reset prefix): Emit an SGR reset (code 0) before setting
  the new colors. This clears all active text attributes (bold, italic,
  underline, etc.) in addition to resetting colors.

## EXAMPLE

An example configuration file `~/.recolor.conf`:

```txt
#   color aliases
fg1 = white
bg1 = blue

#   default color remapping
default:
    white/blue         -> green/black
    bright-white/blue  -> bright-green/black
    yellow/blue        -> yellow/black
    */blue             -> */black
    red/default        -> bright-red/default

#   alternative dark theme
dark:
    */white            -> */black
    black/*            -> white/*
```

Example invocations:

```sh
#   run "mc" (Midnight Commander) with default color remapping
$ ansi-recolor -- mc

#   run "mc" with explicit config file and section
$ ansi-recolor -c ~/.ansi-recolor.conf -n dark -- mc

#   trace all color pairs used by "mc" into a file
$ ansi-recolor -t /tmp/mc-colors.txt -- mc

#   watch the trace file in a second terminal with color previews
$ ansi-recolor -t /tmp/mc-colors.txt -w

#   run with RGB-to-256 pre-mapping enabled
$ ansi-recolor -m -c ~/.ansi-recolor.conf -- mc
```

## WORKFLOW

A typical workflow for creating color mappings for a new application is:

1. Run the application under `ansi-recolor` with `--trace` to
   capture all color pairs it uses:
   `ansi-recolor -t /tmp/trace.txt -- <command>`

2. Optionally, in a second terminal, watch the trace file to see
   color pairs as they appear with visual previews:
   `ansi-recolor -t /tmp/trace.txt -w`

3. Navigate through the application to trigger all color combinations.

4. Use the generated trace file as a starting point for writing
   mapping rules -- it already uses the correct configuration syntax.

5. Copy the desired mappings into the configuration file and adjust
   the target colors as needed.

## HISTORY

`ansi-recolor` was developed in April 2026 as a tool to customize the
color output of TUI applications *without* requiring re-configuration
or even code changes to the applications themselves. In particular, it
was motivated by applying a unobtrusive and less colorful color theme
to *Claude Code* without the need of patching *Claude Code* (with tools
like *TweakCC*), as this regularly failed for new versions of *Claude
Code*.

## AUTHOR

Dr. Ralf S. Engelschall <rse@engelschall.com>

