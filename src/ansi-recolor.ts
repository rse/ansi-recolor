#!/usr/bin/env node
/*!
**  ansi-recolor -- Transform ANSI Color Sequences of TUI Applications
**  Copyright (c) 2026 Dr. Ralf S. Engelschall <rse@engelschall.com>
**  Licensed under MIT license
*/

import os          from "node:os"
import path        from "node:path"
import fs          from "node:fs"
import process     from "node:process"

import yargs       from "yargs"
import { hideBin } from "yargs/helpers"
import * as pty    from "node-pty"
import ttyAttr     from "tty-attr"

/*  ==== type definitions ====  */

/*  a color specification as parsed from the config file  */
type ColorSpec =
    | { type: "wildcard", dim: boolean, reset: boolean }
    | { type: "default",  dim: boolean, reset: boolean }
    | { type: "basic",  index: number, dim: boolean, reset: boolean }
    | { type: "bright", index: number, dim: boolean, reset: boolean }
    | { type: "256",    index: number, dim: boolean, reset: boolean }
    | { type: "rgb",    r: number, g: number, b: number, dim: boolean, reset: boolean }

/*  a color that is currently active on the terminal  */
type ActiveColor =
    | { type: "default" }
    | { type: "basic",  index: number }
    | { type: "bright", index: number }
    | { type: "256",    index: number }
    | { type: "rgb",    r: number, g: number, b: number }

/*  a mapping rule from the config file  */
type ColorMapping = {
    fromFg: ColorSpec
    fromBg: ColorSpec
    toFg:   ColorSpec
    toBg:   ColorSpec
}

/*  ==== config file parsing ====  */

/*  lookup table for basic color names  */
const basicColors: Record<string, number> = {
    "black": 0, "red":     1, "green": 2, "yellow": 3,
    "blue":  4, "magenta": 5, "cyan":  6, "white":  7
}

/*  parse a hex RGB string (#RGB or #RRGGBB) into its channel values  */
const parseHexRgb = (hex: string): { r: number, g: number, b: number } => {
    if (hex.length === 3) {
        return {
            r: parseInt(hex[0] + hex[0], 16),
            g: parseInt(hex[1] + hex[1], 16),
            b: parseInt(hex[2] + hex[2], 16)
        }
    }
    return {
        r: parseInt(hex.substring(0, 2), 16),
        g: parseInt(hex.substring(2, 4), 16),
        b: parseInt(hex.substring(4, 6), 16)
    }
}

/*  parse a single color spec string (resolving named aliases)  */
const parseColorSpec = (spec: string, line: number, aliases: Record<string, string> = {}): ColorSpec => {
    /*  extract style-reset prefix ("!") and dim/faint suffix ("-")  */
    let reset = false
    let dim   = false
    if (spec.startsWith("!")) {
        reset = true
        spec = spec.substring(1)
    }
    if (spec.endsWith("-")) {
        dim = true
        spec = spec.substring(0, spec.length - 1)
    }

    if (spec === "*")
        return { type: "wildcard", dim, reset }
    if (spec === "default")
        return { type: "default", dim, reset }
    if (basicColors[spec] !== undefined)
        return { type: "basic", index: basicColors[spec], dim, reset }
    const brightMatch = spec.match(/^bright-(.+)$/)
    if (brightMatch !== null) {
        const idx = basicColors[brightMatch[1]]
        if (idx !== undefined)
            return { type: "bright", index: idx, dim, reset }
        throw new Error(`invalid bright color "${spec}" on line ${line}`)
    }
    const c256Match = spec.match(/^(\d+)$/)
    if (c256Match !== null) {
        const idx = parseInt(c256Match[1], 10)
        if (idx > 255)
            throw new Error(`256-color index out of range in "${spec}" on line ${line}`)
        return { type: "256", index: idx, dim, reset }
    }
    const rgbMatch = spec.match(/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/)
    if (rgbMatch !== null) {
        const { r, g, b } = parseHexRgb(rgbMatch[1])
        return { type: "rgb", r, g, b, dim, reset }
    }

    /*  resolve named color alias (propagate dim/reset from referencing spec)  */
    if (aliases[spec] !== undefined) {
        const resolved = parseColorSpec(aliases[spec], line, aliases)
        return { ...resolved, dim: dim || resolved.dim, reset: reset || resolved.reset } as ColorSpec
    }
    throw new Error(`invalid color spec "${spec}" on line ${line}`)
}

/*  parse a color pair like "<fg>/<bg>"  */
const parseColorPair = (token: string, line: number, aliases: Record<string, string> = {}): { fg: ColorSpec, bg: ColorSpec } => {
    const match = token.match(/^([^/]+)\/(.+)$/)
    if (match === null)
        throw new Error(`invalid color pair "${token}" on line ${line}`)
    return {
        fg: parseColorSpec(match[1], line, aliases),
        bg: parseColorSpec(match[2], line, aliases)
    }
}

/*  parse the entire config file and return mappings for a named section  */
const parseConfig = (text: string, name: string): ColorMapping[] => {
    const sections: Record<string, ColorMapping[]> = {}
    const aliases:  Record<string, string> = {}
    let currentSection: string | null = null
    const lines = text.split("\n")
    for (let i = 0; i < lines.length; i++) {
        const raw = lines[i]

        /*  skip blank lines and comments  */
        if (raw.trim() === "" || raw.trim().startsWith("#"))
            continue

        /*  color alias definition (non-indented "<name> = <color>")  */
        const aliasMatch = raw.match(/^(\S+)\s*=\s*(\S+)$/)
        if (aliasMatch !== null) {
            aliases[aliasMatch[1]] = aliasMatch[2]
            continue
        }

        /*  section header (non-indented line ending with ":")  */
        const sectionMatch = raw.match(/^(\S+):$/)
        if (sectionMatch !== null) {
            currentSection = sectionMatch[1]
            if (sections[currentSection] === undefined)
                sections[currentSection] = []
            continue
        }

        /*  mapping rule (indented line with "<from> -> <to>")  */
        const mappingMatch = raw.match(/^\s+(\S+)\s+->\s+(\S+)\s*$/)
        if (mappingMatch !== null) {
            if (currentSection === null)
                throw new Error(`mapping outside of section on line ${i + 1}`)
            const from = parseColorPair(mappingMatch[1], i + 1, aliases)
            const to   = parseColorPair(mappingMatch[2], i + 1, aliases)
            sections[currentSection].push({
                fromFg: from.fg,
                fromBg: from.bg,
                toFg:   to.fg,
                toBg:   to.bg
            })
            continue
        }
        throw new Error(`invalid syntax on line ${i + 1}: "${raw.trim()}"`)
    }
    if (sections[name] === undefined)
        throw new Error(`section "${name}" not found in config file`)
    return sections[name]
}

/*  ==== ANSI SGR color transformation ====  */

/*  current terminal color state (what the app "thinks" it set)  */
let currentFg:  ActiveColor = { type: "default" }
let currentBg:  ActiveColor = { type: "default" }
let currentDim              = false

/*  actual terminal display state (what was last sent to the real terminal)  */
let terminalFg: ActiveColor = { type: "default" }
let terminalBg: ActiveColor = { type: "default" }

/*  trace mode state  */
let traceFd: number | null = null
let traceHeaderWritten     = false
const seenPairs            = new Set<string>()

/*  check whether two ActiveColors are identical  */
const sameColor = (a: ActiveColor, b: ActiveColor): boolean => {
    if (a.type !== b.type)
        return false
    switch (a.type) {
        case "default":
            return true
        case "basic":
        case "bright":
        case "256":
            return a.index === (b as typeof a).index
        case "rgb":
            return a.r === (b as typeof a).r
                && a.g === (b as typeof a).g
                && a.b === (b as typeof a).b
    }
}

/*  check whether a ColorSpec matches an ActiveColor  */
const matchesColor = (spec: ColorSpec, color: ActiveColor, dimActive: boolean): boolean => {
    /*  dim flag on source: require dim to be active (reset flag is ignored on source)  */
    if (spec.dim && !dimActive)
        return false
    if (spec.type === "wildcard")
        return true
    if (spec.type !== color.type)
        return false
    switch (color.type) {
        case "default":
            return true
        case "basic":
        case "bright":
        case "256":
            return (spec as typeof color).index === color.index
        case "rgb":
            return (spec as typeof color).r === color.r
                && (spec as typeof color).g === color.g
                && (spec as typeof color).b === color.b
    }
}

/*  apply mapping rules and return the (possibly remapped) fg/bg
    (uses last-match strategy: all matching rules are applied in order,
    with later rules overriding earlier ones; "*" on the target side
    means "keep the current value", i.e., do not change it if not
    given by any rule, and keep it if given by an earlier rule)  */
const applyMappings = (mappings: ColorMapping[], fg: ActiveColor, bg: ActiveColor, dimActive: boolean): {
    fg: ActiveColor, bg: ActiveColor, dim: boolean, dimExplicit: boolean, reset: boolean
} => {
    let resultFg:    ActiveColor = fg
    let resultBg:    ActiveColor = bg
    let resultDim                = dimActive
    let dimExplicit              = false
    let resultReset              = false
    for (const rule of mappings) {
        if (matchesColor(rule.fromFg, fg, dimActive) && matchesColor(rule.fromBg, bg, dimActive)) {
            if (rule.toFg.type !== "wildcard")
                resultFg = rule.toFg as ActiveColor
            if (rule.toBg.type !== "wildcard")
                resultBg = rule.toBg as ActiveColor

            /*  dim: if any non-wildcard target, use target's dim flags  */
            if (rule.toFg.type !== "wildcard" || rule.toBg.type !== "wildcard") {
                resultDim   = rule.toFg.dim || rule.toBg.dim
                dimExplicit = true
            }

            /*  reset: if any target has reset flag, trigger style reset  */
            if (rule.toFg.reset || rule.toBg.reset)
                resultReset = true
        }
    }
    return { fg: resultFg, bg: resultBg, dim: resultDim, dimExplicit, reset: resultReset }
}

/*  reverse lookup table for basic color names  */
const basicColorNames: Record<number, string> = {}
for (const [ name, idx ] of Object.entries(basicColors))
    basicColorNames[idx] = name

/*  convert an ActiveColor back to its config-file string representation  */
const activeColorToString = (color: ActiveColor): string => {
    switch (color.type) {
        case "default": return "default"
        case "basic":   return basicColorNames[color.index] ?? `${color.index}`
        case "bright":  return `bright-${basicColorNames[color.index] ?? String(color.index)}`
        case "256":     return `${color.index}`
        case "rgb": {
            const hex = (color.r << 16 | color.g << 8 | color.b)
                .toString(16).padStart(6, "0").toUpperCase()
            return `#${hex}`
        }
    }
}

/*  the ANSI 256-color palette's 6x6x6 color cube channel values  */
const cubeValues = [ 0, 0x5F, 0x87, 0xAF, 0xD7, 0xFF ]

/*  find the nearest cube index for a single channel value  */
const nearestCubeIndex = (v: number): number => {
    let best = 0
    let bestDist = Math.abs(v - cubeValues[0])
    for (let i = 1; i < 6; i++) {
        const d = Math.abs(v - cubeValues[i])
        if (d < bestDist) {
            bestDist = d
            best = i
        }
    }
    return best
}

/*  map an RGB color to the nearest ANSI 256-color palette index  */
const rgbToNearest256 = (r: number, g: number, b: number): number => {
    /*  candidate from the 6x6x6 color cube (indices 16–231)  */
    const ri = nearestCubeIndex(r)
    const gi = nearestCubeIndex(g)
    const bi = nearestCubeIndex(b)
    const cubeIdx  = 16 + 36 * ri + 6 * gi + bi
    const cubeDist = (r - cubeValues[ri]) ** 2 + (g - cubeValues[gi]) ** 2 + (b - cubeValues[bi]) ** 2

    /*  candidate from the grayscale ramp (indices 232–255)  */
    const gray     = Math.round((r + g + b) / 3)
    const grayStep = Math.min(23, Math.max(0, Math.round((gray - 8) / 10)))
    const grayVal  = 8 + grayStep * 10
    const grayIdx  = 232 + grayStep
    const grayDist = (r - grayVal) ** 2 + (g - grayVal) ** 2 + (b - grayVal) ** 2

    return grayDist < cubeDist ? grayIdx : cubeIdx
}

/*  map an RGB ActiveColor to the nearest 256-color ActiveColor  */
const mapRgbTo256 = (color: ActiveColor): ActiveColor => {
    if (color.type === "rgb")
        return { type: "256", index: rgbToNearest256(color.r, color.g, color.b) }
    return color
}

/*  convert an ActiveColor to its SGR parameter sequence  */
const colorToSGR = (color: ActiveColor, kind: "fg" | "bg"): number[] => {
    const offset = kind === "fg" ? 0 : 10
    switch (color.type) {
        case "default": return [ kind === "fg" ? 39 : 49 ]
        case "basic":   return [ 30 + offset + color.index ]
        case "bright":  return [ 90 + offset + color.index ]
        case "256":     return [ 38 + offset, 5, color.index ]
        case "rgb":     return [ 38 + offset, 2, color.r, color.g, color.b ]
    }
}

/*  transform an SGR parameter sequence, rewriting colors according to mappings  */
const transformSGR = (params: number[], mappings: ColorMapping[], mapColors: boolean): number[] => {
    const nonColorParams: number[] = []
    let newFg:  ActiveColor = currentFg
    let newBg:  ActiveColor = currentBg
    let newDim: boolean     = currentDim
    let fgChanged  = false
    let bgChanged  = false
    let dimChanged = false

    /*  walk through the SGR parameters sequentially  */
    let i = 0
    while (i < params.length) {
        const p = params[i]
        if (p === 0) {
            /*  reset: clears all attributes and colors  */
            nonColorParams.push(0)
            newFg  = { type: "default" }
            newBg  = { type: "default" }
            newDim = false
            fgChanged  = true
            bgChanged  = true
            dimChanged = true
            i++
        }
        else if (p === 2) {
            /*  dim/faint attribute on  */
            newDim = true
            dimChanged = true
            nonColorParams.push(p)
            i++
        }
        else if (p === 22) {
            /*  normal intensity (clears both bold and dim)  */
            newDim = false
            dimChanged = true
            nonColorParams.push(p)
            i++
        }
        else if (p >= 30 && p <= 37) {
            newFg = { type: "basic", index: p - 30 }
            fgChanged = true
            i++
        }
        else if (p === 38 && i + 1 < params.length) {
            if (params[i + 1] === 5 && i + 2 < params.length) {
                newFg = { type: "256", index: params[i + 2] }
                fgChanged = true
                i += 3
            }
            else if (params[i + 1] === 2 && i + 4 < params.length) {
                newFg = { type: "rgb", r: params[i + 2], g: params[i + 3], b: params[i + 4] }
                fgChanged = true
                i += 5
            }
            else {
                /*  malformed extended color -- pass through  */
                nonColorParams.push(params[i])
                i++
            }
        }
        else if (p === 39) {
            newFg = { type: "default" }
            fgChanged = true
            i++
        }
        else if (p >= 40 && p <= 47) {
            newBg = { type: "basic", index: p - 40 }
            bgChanged = true
            i++
        }
        else if (p === 48 && i + 1 < params.length) {
            if (params[i + 1] === 5 && i + 2 < params.length) {
                newBg = { type: "256", index: params[i + 2] }
                bgChanged = true
                i += 3
            }
            else if (params[i + 1] === 2 && i + 4 < params.length) {
                newBg = { type: "rgb", r: params[i + 2], g: params[i + 3], b: params[i + 4] }
                bgChanged = true
                i += 5
            }
            else {
                /*  malformed extended color -- pass through  */
                nonColorParams.push(params[i])
                i++
            }
        }
        else if (p === 49) {
            newBg = { type: "default" }
            bgChanged = true
            i++
        }
        else if (p >= 90 && p <= 97) {
            newFg = { type: "bright", index: p - 90 }
            fgChanged = true
            i++
        }
        else if (p >= 100 && p <= 107) {
            newBg = { type: "bright", index: p - 100 }
            bgChanged = true
            i++
        }
        else {
            /*  non-color attribute (bold, italic, underline, etc.)  */
            nonColorParams.push(p)
            i++
        }
    }

    /*  pre-map RGB/truecolor to nearest 256-color palette color  */
    if (mapColors) {
        newFg = mapRgbTo256(newFg)
        newBg = mapRgbTo256(newBg)
    }

    /*  update tracked state to what the app intended  */
    currentFg  = newFg
    currentBg  = newBg
    currentDim = newDim

    /*  record color pair for trace mode  */
    if (traceFd !== null && (fgChanged || bgChanged || dimChanged)) {
        const dimSuffix = currentDim ? "-" : ""
        const fgStr = activeColorToString(currentFg) + dimSuffix
        const bgStr = activeColorToString(currentBg)
        const key   = `${fgStr}/${bgStr}`
        if (!seenPairs.has(key)) {
            seenPairs.add(key)
            if (!traceHeaderWritten) {
                fs.writeSync(traceFd, "default:\n")
                traceHeaderWritten = true
            }
            fs.writeSync(traceFd, `    ${key.padEnd(20)} -> ${key}\n`)
        }
    }

    /*  apply mapping rules  */
    const mapped = applyMappings(mappings, newFg, newBg, newDim)

    /*  reconstruct the SGR parameter sequence  */
    const result = [ ...nonColorParams ]
    let hasReset = nonColorParams.includes(0)

    /*  handle style-reset flag ("!") from mapping target  */
    if (mapped.reset && !hasReset) {
        result.unshift(0)
        hasReset   = true
        terminalFg = { type: "default" }
        terminalBg = { type: "default" }
    }

    /*  emit fg if it differs from what the terminal currently displays  */
    const fgDiffers = !sameColor(mapped.fg, terminalFg)
    if ((fgChanged || fgDiffers) && !(hasReset && mapped.fg.type === "default"))
        result.push(...colorToSGR(mapped.fg, "fg"))

    /*  emit bg if it differs from what the terminal currently displays  */
    const bgDiffers = !sameColor(mapped.bg, terminalBg)
    if ((bgChanged || bgDiffers) && !(hasReset && mapped.bg.type === "default"))
        result.push(...colorToSGR(mapped.bg, "bg"))

    /*  handle dim/faint flag ("-") from mapping target  */
    if (mapped.dimExplicit) {
        if (mapped.dim)
            result.push(2)
        else if (newDim && !hasReset)
            result.push(22)
    }

    /*  update terminal display state  */
    terminalFg = hasReset ?
        (mapped.fg.type === "default" ? { type: "default" } : mapped.fg) :
        (fgChanged || fgDiffers       ? mapped.fg           : terminalFg)
    terminalBg = hasReset ?
        (mapped.bg.type === "default" ? { type: "default" } : mapped.bg) :
        (bgChanged || bgDiffers       ? mapped.bg           : terminalBg)
    return result
}

/*  ==== stream processing with partial sequence buffering ====  */

let buf: Buffer = Buffer.alloc(0)

/*  parser states for the escape sequence state machine  */
const S_NORMAL     = 0  /*  plain text, scanning for ESC           */
const S_ESC        = 1  /*  just saw ESC, determining sequence type */
const S_ESC_INTER  = 2  /*  ESC + intermediate bytes (nF sequence) */
const S_CSI_PARAM  = 3  /*  CSI parameter bytes                    */
const S_CSI_INTER  = 4  /*  CSI intermediate bytes                 */
const S_STR_BODY   = 5  /*  string command body (OSC/DCS/APC/PM/SOS) */
const S_STR_ESC    = 6  /*  ESC inside string command (potential ST)  */

/*  process a raw byte chunk through the escape sequence state machine
    (operates on raw bytes so UTF-8 multi-byte sequences are never decoded/buffered;
    ESC and all escape sequence bytes are in the ASCII range 0x00-0x7F which never
    overlaps with UTF-8 continuation bytes 0x80-0xBF, so raw scanning is safe)  */
const processChunk = (chunk: Buffer, mappings: ColorMapping[], mapColors: boolean): Buffer => {
    buf = buf.length === 0 ? chunk : Buffer.concat([ buf, chunk ])
    const out: Buffer[] = []
    let i = 0
    let seqStart = -1
    let state = S_NORMAL

    while (i < buf.length) {
        const ch = buf[i]
        switch (state) {
            case S_NORMAL: {
                /*  fast-scan for next ESC byte  */
                const escIdx = buf.indexOf(0x1B, i)
                if (escIdx === -1) {
                    out.push(buf.subarray(i))
                    i = buf.length
                }
                else {
                    if (escIdx > i)
                        out.push(buf.subarray(i, escIdx))
                    seqStart = escIdx
                    state = S_ESC
                    i = escIdx + 1
                }
                break
            }

            case S_ESC:
                if (ch === 0x5B) {
                    /*  "[" → CSI sequence  */
                    state = S_CSI_PARAM
                    i++
                }
                else if (ch === 0x5D || ch === 0x50 || ch === 0x5F
                      || ch === 0x5E || ch === 0x58) {
                    /*  "]" / "P" / "_" / "^" / "X" → string command  */
                    state = S_STR_BODY
                    i++
                }
                else if (ch >= 0x20 && ch <= 0x2F) {
                    /*  intermediate byte → nF escape sequence  */
                    state = S_ESC_INTER
                    i++
                }
                else if (ch >= 0x30 && ch <= 0x7E) {
                    /*  final byte → simple two-byte ESC sequence  */
                    out.push(buf.subarray(seqStart, i + 1))
                    state = S_NORMAL
                    i++
                }
                else {
                    /*  unexpected byte → flush ESC and re-process  */
                    out.push(buf.subarray(seqStart, seqStart + 1))
                    state = S_NORMAL
                    i = seqStart + 1
                }
                break

            case S_ESC_INTER:
                if (ch >= 0x20 && ch <= 0x2F) {
                    /*  more intermediate bytes  */
                    i++
                }
                else if (ch >= 0x30 && ch <= 0x7E) {
                    /*  final byte → complete nF sequence  */
                    out.push(buf.subarray(seqStart, i + 1))
                    state = S_NORMAL
                    i++
                }
                else {
                    /*  unexpected → flush and re-process  */
                    out.push(buf.subarray(seqStart, i))
                    state = S_NORMAL
                }
                break

            case S_CSI_PARAM:
                if (ch >= 0x30 && ch <= 0x3F) {
                    /*  parameter byte (digits, ";", "?", ">", etc.)  */
                    i++
                }
                else if (ch >= 0x20 && ch <= 0x2F) {
                    /*  intermediate byte  */
                    state = S_CSI_INTER
                    i++
                }
                else if (ch >= 0x40 && ch <= 0x7E) {
                    /*  final byte → CSI sequence complete  */
                    if (ch === 0x6D) {
                        /*  "m" → SGR: transform colors  */
                        const paramStr = buf.subarray(seqStart + 2, i).toString("ascii")
                        if (/^[0-9;]*$/.test(paramStr)) {
                            const params = paramStr === "" ? [ 0 ] : paramStr.split(";").map(Number)
                            const mapped = transformSGR(params, mappings, mapColors)
                            out.push(Buffer.from(`\x1b[${mapped.join(";")}m`))
                        }
                        else
                            out.push(buf.subarray(seqStart, i + 1))
                    }
                    else {
                        /*  DIAGNOSTIC: strip synchronized output BSU/ESU markers  */
                        const csiParams = buf.subarray(seqStart + 2, i).toString("ascii")
                        if (csiParams === "?2026" && (ch === 0x68 || ch === 0x6C)) {
                            /* strip BSU (h) / ESU (l) */
                        }
                        else
                            out.push(buf.subarray(seqStart, i + 1))
                    }
                    state = S_NORMAL
                    i++
                }
                else {
                    /*  unexpected → flush and re-process  */
                    out.push(buf.subarray(seqStart, i))
                    state = S_NORMAL
                }
                break

            case S_CSI_INTER:
                if (ch >= 0x20 && ch <= 0x2F) {
                    /*  more intermediate bytes  */
                    i++
                }
                else if (ch >= 0x40 && ch <= 0x7E) {
                    /*  final byte → CSI sequence complete (non-SGR)  */
                    out.push(buf.subarray(seqStart, i + 1))
                    state = S_NORMAL
                    i++
                }
                else {
                    /*  unexpected → flush and re-process  */
                    out.push(buf.subarray(seqStart, i))
                    state = S_NORMAL
                }
                break

            case S_STR_BODY:
                if (ch === 0x1B) {
                    /*  ESC inside string command → potential ST  */
                    state = S_STR_ESC
                    i++
                }
                else if (ch === 0x07) {
                    /*  BEL terminates string commands (at least OSC)  */
                    out.push(buf.subarray(seqStart, i + 1))
                    state = S_NORMAL
                    i++
                }
                else
                    i++
                break

            case S_STR_ESC:
                if (ch === 0x5C) {
                    /*  "\" → ST (String Terminator) → string command complete  */
                    out.push(buf.subarray(seqStart, i + 1))
                    state = S_NORMAL
                    i++
                }
                else {
                    /*  not ST → ESC starts a new sequence (malformed input)  */
                    out.push(buf.subarray(seqStart, i - 1))
                    seqStart = i - 1
                    state = S_ESC
                }
                break
        }
    }

    /*  keep any incomplete escape sequence in the buffer  */
    if (state !== S_NORMAL)
        buf = Buffer.from(buf.subarray(seqStart))
    else
        buf = Buffer.alloc(0)
    return Buffer.concat(out)
}

/*  ==== trace-file watch mode ====  */

/*  convert a color spec string to an SGR parameter sequence (for swatch rendering)  */
const swatchColorToSGR = (spec: string, kind: "fg" | "bg"): string => {
    const offset = kind === "fg" ? 0 : 10
    if (spec === "default")
        return `${kind === "fg" ? 39 : 49}`
    if (basicColors[spec] !== undefined)
        return `${30 + offset + basicColors[spec]}`
    const brightMatch = spec.match(/^bright-(.+)$/)
    if (brightMatch !== null && basicColors[brightMatch[1]] !== undefined)
        return `${90 + offset + basicColors[brightMatch[1]]}`
    const c256Match = spec.match(/^(\d+)$/)
    if (c256Match !== null)
        return `${38 + offset};5;${c256Match[1]}`
    const rgbMatch = spec.match(/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/)
    if (rgbMatch !== null) {
        const { r, g, b } = parseHexRgb(rgbMatch[1])
        return `${38 + offset};2;${r};${g};${b}`
    }
    return `${kind === "fg" ? 39 : 49}`
}

/*  render a colored "[XXX]" swatch for a given fg/bg color pair  */
const renderSwatch = (fg: string, bg: string): string => {
    const fgSGR = swatchColorToSGR(fg, "fg")
    const bgSGR = swatchColorToSGR(bg, "bg")
    return `\x1b[${fgSGR};${bgSGR}m[XXX]\x1b[0m`
}

/*  process a chunk of trace-file text and output lines with color swatches  */
const processTraceChunk = (text: string, partial: string, watchAliases: Record<string, string>): string => {
    const input = partial + text
    const lines = input.split("\n")
    const remainder = lines.pop() ?? ""
    for (const line of lines) {
        const aliasMatch = line.match(/^(\S+)\s*=\s*(\S+)$/)
        if (aliasMatch !== null) {
            watchAliases[aliasMatch[1]] = aliasMatch[2]
            process.stdout.write(`${line}\n`)
            continue
        }
        const mappingMatch = line.match(/^(\s+)(\S+\/\S+)(\s+->\s+)(\S+\/\S+)(.*)$/)
        if (mappingMatch !== null) {
            const indent = mappingMatch[1]
            const from   = mappingMatch[2]
            const arrow  = mappingMatch[3]
            const to     = mappingMatch[4]
            const rest   = mappingMatch[5]
            const fromMatch = from.match(/^([^/]+)\/(.+)$/)
            const toMatch   = to.match(/^([^/]+)\/(.+)$/)
            if (fromMatch !== null && toMatch !== null) {
                const resolveAlias = (s: string): string => {
                    const seen = new Set<string>()
                    let cur = s
                    while (watchAliases[cur] !== undefined && !seen.has(cur)) {
                        seen.add(cur)
                        cur = watchAliases[cur]
                    }
                    return cur
                }
                const fromSwatch = renderSwatch(resolveAlias(fromMatch[1]), resolveAlias(fromMatch[2]))
                const toSwatch   = renderSwatch(resolveAlias(toMatch[1]),   resolveAlias(toMatch[2]))
                process.stdout.write(`${indent}${fromSwatch} ${from}${arrow}${toSwatch} ${to}${rest}\n`)
                continue
            }
        }
        process.stdout.write(`${line}\n`)
    }
    return remainder
}

/*  watch a trace file and output its content with color swatches  */
const watchTraceFile = (filePath: string): void => {
    const watchAliases: Record<string, string> = {}
    const initial = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf-8") : ""
    let partial   = processTraceChunk(initial, "", watchAliases)
    let offset    = Buffer.byteLength(initial, "utf-8")
    fs.watchFile(filePath, { interval: 200 }, () => {
        try {
            const stat = fs.statSync(filePath)
            if (stat.size > offset) {
                const fd      = fs.openSync(filePath, "r")
                const readBuf = Buffer.alloc(stat.size - offset)
                fs.readSync(fd, readBuf, 0, readBuf.length, offset)
                fs.closeSync(fd)
                offset  = stat.size
                partial = processTraceChunk(readBuf.toString("utf-8"), partial, watchAliases)
            }
            else if (stat.size < offset) {
                const content = fs.readFileSync(filePath, "utf-8")
                offset  = Buffer.byteLength(content, "utf-8")
                partial = processTraceChunk(content, "", watchAliases)
            }
        }
        catch {
            /*  file temporarily inaccessible, retry on next interval  */
        }
    })
}

/*  write a fatal error message and exit  */
const fatalError = (context: string, err: unknown): never => {
    const msg = err instanceof Error ? err.message : String(err)
    process.stderr.write(`recolor: ERROR: ${context}: ${msg}\n`)
    process.exit(1)
}

/*  ==== CLI entry point ====  */

const main = async (): Promise<void> => {
    /*  parse command-line arguments  */
    const argv = await yargs(hideBin(process.argv))
        .usage("Usage: $0 " +
            "[-c|--config <config-file>] " +
            "[-n|--name <config-section>] " +
            "[-m|--map] " +
            "[-t|--trace <trace-file>] " +
            "[-w|--watch] " +
            "[--] " +
            "<command> [<args>...]"
        )
        .option("c", {
            alias:       "config",
            type:        "string",
            description: "path to config file"
        })
        .option("n", {
            alias:       "name",
            type:        "string",
            description: "name of config section",
            default:     "default"
        })
        .option("m", {
            alias:       "map",
            type:        "boolean",
            description: "map RGB/truecolor to nearest 256-color before remapping",
            default:     false
        })
        .option("t", {
            alias:       "trace",
            type:        "string",
            description: "path to trace file"
        })
        .option("w", {
            alias:       "watch",
            type:        "boolean",
            description: "watch trace file and print with color previews",
            default:     false
        })
        .parserConfiguration({
            "halt-at-non-option": true
        })
        .strict(true)
        .help().alias("h", "help")
        .version().alias("V", "version")
        .parseAsync()
    let   configPath  = argv.c
    const sectionName = argv.n!
    const tracePath   = argv.t
    const watchMode   = argv.w!
    const mapColors   = argv.m!
    const appArgs     = argv._
    if (tracePath === undefined && configPath === undefined)
        configPath = path.join(os.homedir(), ".ansi-recolor.conf")

    /*  watch mode: watch the trace file and print with color previews  */
    if (watchMode) {
        if (tracePath === undefined) {
            process.stderr.write("recolor: ERROR: --watch requires --trace/-t <file>\n")
            process.exit(1)
        }
        if (appArgs.length > 0) {
            process.stderr.write("recolor: ERROR: --watch does not accept a command\n")
            process.exit(1)
        }
        watchTraceFile(tracePath)
        return
    }

    if (appArgs.length === 0) {
        process.stderr.write("recolor: ERROR: no command specified\n")
        process.exit(1)
    }
    const app      = String(appArgs[0])
    const restArgs = appArgs.slice(1).map(String)

    /*  open trace file if requested  */
    if (tracePath !== undefined) {
        try {
            traceFd = fs.openSync(tracePath, "w")
        }
        catch (err: unknown) {
            fatalError("failed to open trace file", err)
        }
    }

    /*  read and parse the config file (skip when in trace mode)  */
    let mappings: ColorMapping[] = []
    if (configPath !== undefined && fs.existsSync(configPath)) {
        let configText: string
        try {
            configText = fs.readFileSync(configPath, "utf-8")
            mappings = parseConfig(configText, sectionName)
        }
        catch (err: unknown) {
            fatalError("failed to read and parse config file", err)
        }
    }

    /*  spawn the application in a PTY  */
    const term = pty.spawn(app, restArgs, {
        name: process.env["TERM"] ?? "xterm-color",
        cols: process.stdout.columns ?? 80,
        rows: process.stdout.rows    ?? 24,
        cwd:  process.cwd(),
        env:  Object.fromEntries(
            Object.entries(process.env)
                .filter((e): e is [ string, string ] => e[1] !== undefined)),
        encoding: null
    })

    /*  pipe PTY output through color transformation to stdout  */
    term.onData((data: Buffer | string) => {
        const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data)
        const transformed = processChunk(chunk, mappings, mapColors)
        if (transformed.length > 0)
            fs.writeSync(1, transformed)
    })

    /*  pipe stdin to the PTY  */
    if (process.stdin.isTTY) {
        ttyAttr.preserveAttr()
        ttyAttr.setRawMode()
    }
    process.stdin.on("data", (data: Buffer) => {
        term.write(data)
    })
    process.stdin.resume()

    /*  handle terminal resize  */
    process.stdout.on("resize", () => {
        term.resize(
            process.stdout.columns ?? 80,
            process.stdout.rows    ?? 24
        )
    })

    /*  handle child process exit  */
    term.onExit(({ exitCode }: { exitCode: number }) => {
        if (traceFd !== null)
            fs.closeSync(traceFd)
        if (process.stdin.isTTY)
            ttyAttr.restoreAttr()
        process.stdin.pause()
        process.exit(exitCode)
    })
}
main().catch((err: unknown) => {
    fatalError("unexpected failure", err)
})

