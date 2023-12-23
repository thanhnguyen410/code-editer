/**
 * and https://github.com/angelozerr/CodeMirror-XQuery/wiki/Completion-with-Templates
 * based on https://github.com/angelozerr/CodeMirror-XQuery/blob/master/codemirror-extension/addon/hint/templates-hint.js
 *
 * NOTE: Known issues
 * pressing tab interferes with autocomplete
 * presseing escape interferes with autocomplete
 */
import {cssRaw} from 'typestyle';
cssRaw(require("./templates.css"));
import CodeMirror = require('codemirror');
import {ExtendedCodeMirrorHint, render, isCompletionActive} from "./autocompleteShared";
import {TemplatesForContext, defaultSnippets, TemplateConfig} from "./snippets";
let Pos = CodeMirror.Pos;

/** Extensions by templates extension */
declare global {
    module CodeMirror {
        interface Editor {
            /**
             * This overload (with the aggressive parameter) does exist
             * By default its false. And in that CodeMirror eats up whitespace.
             * But we want to indent our whitespace in templates so we pass it as true
             */
            indentLine(line: number, dir?: string, aggressive?: boolean): void;
        }

        interface Hint {
            template?: Template;
            data?: Hint;
            info?: Function;

            /** Used by autocomplete as well */
            comment?: string;
        }
        interface TextMarkerOptions {
            _templateVar?: string;
        }
        interface TextMarker {
            _templateVar?: string;
        }
    }
}

/**
 * Template specific interfaces
 */
interface Marker {
    from: CodeMirror.Position;
    to: CodeMirror.Position

    /** only a single instance of the variable is selectable */
    selectable: boolean;
    variable: string;
    variableIndex: number;
}
type ParsedVariable = {
    index: number;
    name: string;
}
type ParsedToken = string | {
    /**
     * only one of these really. But its more hasel to split it into `|` descriminators
     */
    cursor?: boolean;
    variable?: ParsedVariable;
}

function startsWith(str: string, token: string) {
    return str.slice(0, token.length).toUpperCase() == token.toUpperCase();
}

function getLabel(proposal: { template: TemplateConfig }): Text {
    var template = proposal.template;
    return document.createTextNode(template.name);
}

/** Our keymap */
const ourKeyMap = {
    Tab: function(cm) {
        selectNextVariable(cm);
    },
    'Shift-Tab': selectPreviousVariable,
    Enter: function(cm) {
        gotoLastAndExit(cm);
    },
    Esc: function(cm) {
        uninstall(cm);
    }
}

/** Creates a new template state */
class TemplateState {
    marked = [];
    selectableMarkers = [];
    varIndex = -1;

    /** only set after going into insert mode */
    cursor: CodeMirror.TextMarker;
    updating: boolean;
}

function getState(cm: CodeMirror.Editor): TemplateState {
    return ((cm as any)._templateState);
}
function setState(cm: CodeMirror.Editor, state:TemplateState) {
    (cm as any)._templateState = state;
}
function goIntoInsertMode(cm: CodeMirror.Editor) {
    if (getState(cm)) {
        uninstall(cm);
    }
    var state = new TemplateState();
    setState(cm, state);
    return state;
}


// A Template instance represents an autocompletion template.
// It can be parsed from an eclipse-type template string,
// or supplied with a pre-parsed token array.
//
// The token array may consist of the following tokens:
//   "\n" (newline character)
//       Single newline character per token.
//   text (string)
//       Normal text, no newline characters allowed.
//   { variable: "name" }
//       Variable token, to be populated by the user.
//   { cursor: true }
//       The cursor will be placed here after completing the template
export class Template {
    public name: string;
    public description: string;
    public template: string;

    private _content: string;
    private _tokens: ParsedToken[];

    private _functionCompletion: boolean;

    constructor(data: TemplateConfig) {
        this.name = data.name;
        this.template = data.template;
        this.description = data.description;
        this._functionCompletion = !!data.functionCompletion;
    }

    tokens = () => {
        if (this._tokens == null) {
            this._tokens = parseTemplate(this.template);
        }
        return this._tokens;
    }

    content = () => {
        if (this._content == null) {
            var tokens = this.tokens();
            var content = '';
            for (var i = 0; i < tokens.length; i++) {
                var token = tokens[i];
                if (typeof token === 'string') {
                    content += token;
                } else if (token.variable) {
                    content += token.variable.name;
                } else {
                    // Ignore special tokens
                }
            }
            this._content = content;
        }
        return this._content;
    }

    insert = (cm: CodeMirror.Editor, data: CM.Hints) => {
        let state = goIntoInsertMode(cm);

        const from: CodeMirror.Position = this._functionCompletion ? { line: data.from.line, ch: data.from.ch + 1 } : data.from;

        var tokens = this.tokens();
        var content = '';
        var line = from.line;
        var col = from.ch;
        var markers: Marker[] = [];
        var variableHasBeenAdded: any = {}; // only one instance of the variable is selectable
        var cursor = null;

        for (let i = 0; i < tokens.length; i++) {
            var token = tokens[i];
            if (typeof token === 'string') {
                content += token;
                if (token == "\n") {
                    line++;
                    col = 0;
                } else {
                    col += token.length;
                }
            } else if (token.variable) {
                content += token.variable.name;
                let from = Pos(line, col);
                let to = Pos(line, col
                    + token.variable.name.length);
                var selectable = !variableHasBeenAdded[token.variable.name];
                col += token.variable.name.length;
                markers.push({
                    from: from,
                    to: to,
                    variable: token.variable.name,
                    selectable: selectable,
                    variableIndex: token.variable.index
                });
                variableHasBeenAdded[token.variable.name] = true;
            } else if (token.cursor) {
                cursor = Pos(line, col);
            } else {
                throw new Error('Unknown in Template:' + JSON.stringify(token));
            }
        }

        /** Sort the markers to go up by variable indices */
        markers.sort(m => m.variableIndex);

        const to = data.to;
        const startLine = from.line;
        cm.getDoc().replaceRange(content, from, to);

        for (let i = 0; i < markers.length; i++) {
            const marker = markers[i], from = marker.from, to = marker.to;
            const markText = cm.getDoc().markText(from, to, {
                className: "CodeMirror-templates-variable",
                startStyle: "CodeMirror-templates-variable-start",
                endStyle: "CodeMirror-templates-variable-end",
                inclusiveLeft: true,
                inclusiveRight: true,
                clearWhenEmpty: false,  // Works in CodeMirror 4.6
                _templateVar: marker.variable
            } as any);
            state.marked.push(markText);
            if (marker.selectable == true) {
                state.selectableMarkers.push(markText);
            }
        }

        if (cursor != null) {
            state.cursor = cm.getDoc().setBookmark(cursor);
        }

        // Auto-indent everything except the first line.
        // This will typically indent the rest of the code according
        // to the indentation of the first line.
        //
        // For Whitespace lines we need to tell code mirror to be aggressive
        // Other CM just eats the indents.
        //
        // We do the indentation after creating the markers, so that the
        // markers are moved accordingly.
        const lines = content.split("\n");
        for (let x = 1; x < lines.length; x++) {
            const targetLine = startLine + x;
            if (lines[x].trim()) {
                cm.indentLine(targetLine);
            }
            else {
                (cm as any).indentLine(targetLine, "smart", true);
            }
        }

        // Have to be before selectNextVariable, since selectNextVariable
        // may exit and remove the keymap again.
        cm.on("change", onChange);
        cm.addKeyMap(ourKeyMap);

        selectNextVariable(cm, true);
    }
}

/** goes from string to ParsedToken stream */
function parseTemplate(template: string): ParsedToken[] {
    var tokens: ParsedToken[] = [];
    var varParsing = false;
    var last = null;
    var token = '';
    var lastVariableIndex = 0;
    for (var i = 0; i < template.length; i++) {
        var current = template.charAt(i);
        if (current == "\n") {
            if (token != '') {
                tokens.push(token);
            }
            token = '';
            tokens.push(current);
            last = null;
        } else {
            var addChar = true;
            if (varParsing) {
                if (current == "}") {
                    varParsing = false;
                    addChar = false;
                    if (token == 'cursor') {
                        tokens.push({
                            cursor: true
                        });
                    } else {
                        let tokenSplit = token.split(':');
                        if (tokenSplit.length > 1){
                            let tokenIndex = parseInt(tokenSplit[0]);
                            lastVariableIndex = Math.max(tokenIndex,lastVariableIndex);
                            tokens.push({
                                variable: {
                                    index: tokenIndex,
                                    name: tokenSplit[1]
                                }
                            });
                        }
                        else {
                            tokens.push({
                                variable: {
                                    index: ++lastVariableIndex,
                                    name: token
                                }
                            });
                        }
                    }
                    token = '';
                }
            } else {
                if (current == "$" && (i + 1) <= template.length) {
                    i++;
                    var next = template.charAt(i);
                    if (next == "{") {
                        varParsing = true;
                        addChar = false;
                        if (token != '') {
                            tokens.push(token);
                        }
                        token = '';
                    }
                }

            }
            if (addChar && last != "$") {
                token += current;
                last = current;
            } else {
                last = null;
            }
        }
    }
    if (token != '') {
        tokens.push(token);
    }
    return tokens;
}


function getMarkerChanged(cm: CodeMirror.Editor, textChanged: CodeMirror.EditorChange) {
    var markers = cm.getDoc().findMarksAt(textChanged.from);
    if (markers) {
        for (var i = 0; i < markers.length; i++) {
            var marker = markers[i];
            if ((marker as any)._templateVar) {
                return marker;
            }
        }
    }
    return null;
}

function onChange(cm: CodeMirror.Editor, textChanged: CodeMirror.EditorChange) {
    var state = getState(cm);
    if (!textChanged.origin || !state || state.updating) {
        return;
    }
    try {
        state.updating = true;
        var markerChanged = getMarkerChanged(cm, textChanged);
        if (markerChanged == null) {
            uninstall(cm);
        } else {
            var posChanged = markerChanged.find();
            var newContent = cm.getDoc().getRange(posChanged.from(), posChanged.to());
            for (var i = 0; i < state.marked.length; i++) {
                var marker = state.marked[i];
                if (marker != markerChanged
                    && marker._templateVar == (markerChanged as any)._templateVar) {
                    var pos = marker.find();
                    cm.getDoc().replaceRange(newContent, pos.from, pos.to);
                }
            }
        }
    } finally {
        state.updating = false;
    }
}

function gotoLastAndExit(cm){
    var state = cm._templateState;
    if (state.selectableMarkers.length > 0) {
        state.varIndex = state.selectableMarkers.length;
    }
    exit(cm);
}

function selectNextVariable(cm, exitOnEnd = false) {
    var state = cm._templateState;
    if (state.selectableMarkers.length > 0) {
        state.varIndex++;
        if (state.varIndex >= state.selectableMarkers.length) {
            // If we reach the last token and exitOnEnd is true, we exit instead of
            // looping back to the first token.
            if (exitOnEnd) {
                exit(cm);
                return;
            }
            state.varIndex = 0;
        }
        var marker = state.selectableMarkers[state.varIndex];
        var pos = marker.find();
        cm.setSelection(pos.from, pos.to);
        var templateVar = marker._templateVar;
        for (var i = 0; i < state.marked.length; i++) {
            var m = state.marked[i];
            if (m == marker) {
                m.className = "";
                m.startStyle = "";
                m.endStyle = "";
            } else {
                if (m._templateVar == marker._templateVar) {
                    m.className = "CodeMirror-templates-variable-selected";
                    m.startStyle = "";
                    m.endStyle = "";
                } else {
                    m.className = "CodeMirror-templates-variable";
                    m.startStyle = "CodeMirror-templates-variable-start";
                    m.endStyle = "CodeMirror-templates-variable-end";
                }
            }
        }
        cm.refresh();
    } else {
        // No tokens - exit.
        exit(cm);
    }
}

/** Same as select Next Variable.
 * I just added a `--` on varIndex instead of `++` and changed the loopAround logic accordingly
 * Also remove exit on last logic
 */
function selectPreviousVariable(cm) {
    var state = cm._templateState;
    if (state.selectableMarkers.length > 0) {
        state.varIndex--;
        if (state.varIndex < 0) {
            state.varIndex = state.selectableMarkers.length - 1;
        }
        var marker = state.selectableMarkers[state.varIndex];
        var pos = marker.find();
        cm.setSelection(pos.from, pos.to);
        var templateVar = marker._templateVar;
        for (var i = 0; i < state.marked.length; i++) {
            var m = state.marked[i];
            if (m == marker) {
                m.className = "";
                m.startStyle = "";
                m.endStyle = "";
            } else {
                if (m._templateVar == marker._templateVar) {
                    m.className = "CodeMirror-templates-variable-selected";
                    m.startStyle = "";
                    m.endStyle = "";
                } else {
                    m.className = "CodeMirror-templates-variable";
                    m.startStyle = "CodeMirror-templates-variable-start";
                    m.endStyle = "CodeMirror-templates-variable-end";
                }
            }
        }
        cm.refresh();
    } else {
        // No tokens - exit.
        exit(cm);
    }
}

function exit(cm) {
    // Move to ${cursor} in the template, then uninstall.
    var cursor = cm._templateState.cursor;
    if (cursor != null) {
        var cursorPos = cursor.find();
        if (cursorPos != null) {
            cm.setSelection(cursorPos, cursorPos);
        }
    }
    uninstall(cm);
}

function uninstall(cm) {
    var state = cm._templateState;
    for (var i = 0; i < state.marked.length; i++) {
        state.marked[i].clear();
    }
    if (state.cursor != null) {
        state.cursor.clear();
    }
    state.marked.length = 0;
    state.selectableMarkers.length = 0;
    cm.off("change", onChange);
    cm.removeKeyMap(ourKeyMap);
    delete cm._templateState;
}

/** Renders templates into hints */
export function renderTemplates(cm: CodeMirror.EditorFromTextArea, templates: Template[]): ExtendedCodeMirrorHint[] {
    var mode = cm.getDoc().getMode().name;
    return templates
        .map(template => {
            var label = template.name;
            if (template.description) {
                label += '- ' + template.description;
            }
            var completion: ExtendedCodeMirrorHint = {
                text: label,
            };
            completion.template = template;
            completion.comment = template.description;
            (completion as any).data = completion;
            completion.hint = function(cm, data: CM.Hints, completion: ExtendedCodeMirrorHint) {
                completion.template.insert(cm, data);
            };
            (completion as any).info = function(completion) {
                var content = completion.template.content();
                return content;
            };
            /** Really the only customization we do for template rendering */
            completion.render = render;
            completion.original = {
                kind: 'snippet',
                name: template.name,
                display: template.description,
                comment: template.template
            }
            return completion;
        });
}

/** our global templates registry */
export class TemplatesRegistry {
    private templatesByContext: {[mode:string]:Template[]} = Object.create(null);
    private exactMatchTemplatesbyContext: {
        [mode: string]: {
            [name: string]: Template
        }
    } = Object.create(null);

    constructor(config: TemplatesForContext[]){
        config.forEach(templatesForContext => {
            const context = templatesForContext.context;
            const list = this.templatesByContext[context] = this.templatesByContext[context] || [];
            this.exactMatchTemplatesbyContext[context] = Object.create(null);
            templatesForContext.templates.forEach((template) => {
                const parsedTemplate = new Template(template);
                this.exactMatchTemplatesbyContext[context][template.name] = parsedTemplate;
                list.push(parsedTemplate);
            });
        });
    }

    /**
     * Filters out the templates based on the text and the mode of the editor
     */
    // We only really query for TypeScript context at the moment 🌹
    getNonExactMatchCompletionTemplates(cm: CodeMirror.EditorFromTextArea, text: string): Template[] {
        const context = cm.getDoc().getMode().name;
        const templates = this.templatesByContext[context] || [];
        return templates.filter(template=> template.name!==text && startsWith(template.name, text)).sort();
    }

    /**
     * Returns a template if it matches exactly
     */
    getExactMatchTemplate(cm: CodeMirror.EditorFromTextArea, text: string): Template | null {
        const context = cm.getDoc().getMode().name;
        const templates = this.exactMatchTemplatesbyContext[context] || {};
        return templates[text];
    }
}
export const templatesRegistry = new TemplatesRegistry(defaultSnippets);