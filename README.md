
ANSI Recolor
============

**Transform ANSI Color Sequences of TUI Applications**

[![github (author stars)](https://img.shields.io/github/stars/rse?logo=github&label=author%20stars&color=%233377aa)](https://github.com/rse)
[![github (author followers)](https://img.shields.io/github/followers/rse?label=author%20followers&logo=github&color=%234477aa)](https://github.com/rse)

Abstract
--------

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

`ansi-recolor` was developed in April 2026 as a tool to customize the
color output of TUI applications *without* requiring re-configuration
or even code changes to the applications themselves. In particular, it
was motivated by applying a unobtrusive and less colorful color theme
to *Claude Code* without the need of patching *Claude Code* (with tools
like *TweakCC*), as this regularly failed for new versions of *Claude
Code*.

Installation
------------

```
$ npm install -g ansi-recolor
```

Usage
-----

See the [Unix manual page](src/ansi-recolor.md) for the documentation of the `ansi-recolor` command.

License
-------

Copyright &copy; 2026 Dr. Ralf S. Engelschall (http://engelschall.com/)<br/>
Licensed under [MIT](https://spdx.org/licenses/MIT)

