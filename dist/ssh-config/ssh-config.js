import { spawnSync } from 'node:child_process';
import glob from './glob.js';
const RE_SPACE = /\s/;
const RE_LINE_BREAK = /\r|\n/;
const RE_SECTION_DIRECTIVE = /^(Host|Match)$/i;
const RE_MULTI_VALUE_DIRECTIVE = /^(GlobalKnownHostsFile|Host|IPQoS|SendEnv|UserKnownHostsFile|ProxyCommand|Match|CanonicalDomains)$/i;
const RE_QUOTE_DIRECTIVE = /^(?:CertificateFile|IdentityFile|IdentityAgent|User)$/i;
const RE_SINGLE_LINE_DIRECTIVE = /^(Include|IdentityFile)$/i;
export var LineType;
(function (LineType) {
    LineType[LineType["DIRECTIVE"] = 1] = "DIRECTIVE";
    LineType[LineType["COMMENT"] = 2] = "COMMENT";
})(LineType || (LineType = {}));
const MULTIPLE_VALUE_PROPS = [
    'IdentityFile',
    'LocalForward',
    'RemoteForward',
    'DynamicForward',
    'CertificateFile',
];
function compare(line, opts) {
    return opts.hasOwnProperty(line.param) && opts[line.param] === line.value;
}
function getIndent(config) {
    for (const line of config) {
        if (line.type === LineType.DIRECTIVE && 'config' in line) {
            for (const subline of line.config) {
                if (subline.before) {
                    return subline.before;
                }
            }
        }
    }
    return '  ';
}
function match(criteria, context) {
    const testCriterion = (key, criterion) => {
        switch (key.toLowerCase()) {
            case 'all':
                return true;
            case 'final':
                if (context.inFinalPass) {
                    return true;
                }
                context.doFinalPass = true;
                return false;
            case 'exec':
                const command = `function main {
          ${criterion}
        }
        main`;
                return spawnSync(command, { shell: true }).status === 0;
            case 'host':
                return glob(criterion, context.params.HostName);
            case 'originalhost':
                return glob(criterion, context.params.OriginalHost);
            case 'user':
                return glob(criterion, context.params.User);
            case 'localuser':
                return glob(criterion, context.params.LocalUser);
        }
    };
    for (const key in criteria) {
        const criterion = criteria[key];
        if (!testCriterion(key, criterion)) {
            return false;
        }
    }
    return true;
}
export default class SSHConfig extends Array {
    /**
     * Parse SSH config text into structured object.
     */
    static parse(text) {
        return parse(text);
    }
    /**
     * Stringify structured object into SSH config text.
     */
    static stringify(config) {
        return stringify(config);
    }
    compute(opts) {
        if (typeof opts === 'string')
            opts = { Host: opts };
        const context = {
            params: {
                Host: opts.Host,
                HostName: opts.Host,
                OriginalHost: opts.Host,
                User: "sample",
                LocalUser: "sample",
            },
            inFinalPass: false,
            doFinalPass: false,
        };
        const obj = {};
        const setProperty = (name, value) => {
            if (MULTIPLE_VALUE_PROPS.includes(name)) {
                const list = obj[name] || (obj[name] = []);
                list.push(value);
            }
            else if (obj[name] == null) {
                if (name === 'HostName') {
                    context.params.HostName = value;
                }
                else if (name === 'User') {
                    context.params.User = value;
                }
                obj[name] = value;
            }
        };
        if (opts.User !== undefined) {
            setProperty('User', opts.User);
        }
        const doPass = () => {
            for (const line of this) {
                if (line.type !== LineType.DIRECTIVE)
                    continue;
                if (line.param === 'Host' && glob(line.value, context.params.Host)) {
                    let canonicalizeHostName = false;
                    let canonicalDomains = [];
                    setProperty(line.param, line.value);
                    for (const subline of line.config) {
                        if (subline.type === LineType.DIRECTIVE) {
                            setProperty(subline.param, subline.value);
                            if (/^CanonicalizeHostName$/i.test(subline.param) && subline.value === 'yes') {
                                canonicalizeHostName = true;
                            }
                            if (/^CanonicalDomains$/i.test(subline.param) && Array.isArray(subline.value)) {
                                canonicalDomains = subline.value;
                            }
                        }
                    }
                    
                    if (canonicalDomains.length > 0 && canonicalizeHostName) {
                        for (const domain of canonicalDomains) {
                            const host = `${line.value}.${domain}`;
                            const { stdout } = spawnSync('nslookup', [host]);
                            if (!/server can't find/.test(stdout.toString())) {
                                context.params.Host = host;
                                setProperty('Host', host);
                                doPass();
                                break;
                            }
                        }
                    }
                }
                else if (line.param === 'Match' && 'criteria' in line && match(line.criteria, context)) {
                    for (const subline of line.config) {
                        if (subline.type === LineType.DIRECTIVE) {
                            setProperty(subline.param, subline.value);
                        }
                    }
                }
                else if (line.param !== 'Host' && line.param !== 'Match') {
                    setProperty(line.param, line.value);
                }
            }
        };
        doPass();
        if (context.doFinalPass) {
            context.inFinalPass = true;
            context.params.Host = context.params.HostName;
            doPass();
        }
        return obj;
    }
    find(opts) {
        if (typeof opts === 'function')
            return super.find(opts);
        if (!(opts && ('Host' in opts || 'Match' in opts))) {
            throw new Error('Can only find by Host or Match');
        }
        return super.find(line => compare(line, opts));
    }
    remove(opts) {
        let index;
        if (typeof opts === 'function') {
            index = super.findIndex(opts);
        }
        else if (!(opts && ('Host' in opts || 'Match' in opts))) {
            throw new Error('Can only remove by Host or Match');
        }
        else {
            index = super.findIndex(line => compare(line, opts));
        }
        if (index >= 0)
            return this.splice(index, 1);
    }
    toString() {
        return stringify(this);
    }
    /**
     * Append new section to existing SSH config.
     */
    append(opts) {
        const indent = getIndent(this);
        const lastEntry = this.length > 0 ? this[this.length - 1] : null;
        let config = lastEntry && lastEntry.config || this;
        let configWas = this;
        let lastLine = config.length > 0 ? config[config.length - 1] : lastEntry;
        if (lastLine && !lastLine.after)
            lastLine.after = '\n';
        let sectionLineFound = config !== configWas;
        for (const param in opts) {
            const value = opts[param];
            const line = {
                type: LineType.DIRECTIVE,
                param,
                separator: ' ',
                value,
                before: sectionLineFound ? indent : indent.replace(/  |\t/, ''),
                after: '\n',
            };
            if (RE_SECTION_DIRECTIVE.test(param)) {
                sectionLineFound = true;
                line.before = indent.replace(/  |\t/, '');
                config = configWas;
                // separate sections with an extra newline
                // https://github.com/cyjake/ssh-config/issues/23#issuecomment-564768248
                if (lastLine && lastLine.after === '\n')
                    lastLine.after += '\n';
                config.push(line);
                config = line.config = new SSHConfig();
            }
            else {
                config.push(line);
            }
            lastLine = line;
        }
        return configWas;
    }
    /**
     * Prepend new section to existing SSH config.
     */
    prepend(opts, beforeFirstSection = false) {
        const indent = getIndent(this);
        let config = this;
        let i = 0;
        // insert above known sections
        if (beforeFirstSection) {
            while (i < this.length && !('config' in this[i])) {
                i += 1;
            }
            if (i >= this.length) { // No sections in original config
                return this.append(opts);
            }
        }
        // Prepend new section above the first section
        let sectionLineFound = false;
        let processedLines = 0;
        for (const param in opts) {
            processedLines += 1;
            const value = opts[param];
            const line = {
                type: LineType.DIRECTIVE,
                param,
                separator: ' ',
                value,
                before: '',
                after: '\n',
            };
            if (RE_SECTION_DIRECTIVE.test(param)) {
                line.before = indent.replace(/  |\t/, '');
                config.splice(i, 0, line);
                config = line.config = new SSHConfig();
                sectionLineFound = true;
                continue;
            }
            // separate from previous sections with an extra newline
            if (processedLines === Object.keys(opts).length) {
                line.after += '\n';
            }
            if (!sectionLineFound) {
                config.splice(i, 0, line);
                i += 1;
                // Add an extra newline if a single line directive like Include
                if (RE_SINGLE_LINE_DIRECTIVE.test(param)) {
                    line.after += '\n';
                }
                continue;
            }
            line.before = indent;
            config.push(line);
        }
        return config;
    }
}
SSHConfig.DIRECTIVE = LineType.DIRECTIVE;
SSHConfig.COMMENT = LineType.COMMENT;
/**
 * Parse SSH config text into structured object.
 */
export function parse(text) {
    let i = 0;
    let chr = next();
    let config = new SSHConfig();
    let configWas = config;
    function next() {
        return text[i++];
    }
    function space() {
        let spaces = '';
        while (RE_SPACE.test(chr)) {
            spaces += chr;
            chr = next();
        }
        return spaces;
    }
    function linebreak() {
        let breaks = '';
        while (RE_LINE_BREAK.test(chr)) {
            breaks += chr;
            chr = next();
        }
        return breaks;
    }
    function parameter() {
        let param = '';
        while (chr && /[^ \t=]/.test(chr)) {
            param += chr;
            chr = next();
        }
        return param;
    }
    function separator() {
        let sep = space();
        if (chr === '=') {
            sep += chr;
            chr = next();
        }
        return (sep + space());
    }
    function value() {
        let val = '';
        let quoted = false;
        let escaped = false;
        while (chr && !RE_LINE_BREAK.test(chr)) {
            // backslash escapes only double quotes
            if (escaped) {
                val += chr === '"' ? chr : `\\${chr}`;
                escaped = false;
            }
            // ProxyCommand ssh -W "%h:%p" firewall.example.org
            else if (chr === '"' && (!val || quoted)) {
                quoted = !quoted;
            }
            else if (chr === '\\') {
                escaped = true;
            }
            else {
                val += chr;
            }
            chr = next();
        }
        if (quoted || escaped) {
            throw new Error(`Unexpected line break at ${val}`);
        }
        return val.trim();
    }
    function comment() {
        const type = LineType.COMMENT;
        let content = '';
        while (chr && !RE_LINE_BREAK.test(chr)) {
            content += chr;
            chr = next();
        }
        return { type, content, before: '', after: '' };
    }
    // Host *.co.uk
    // Host * !local.dev
    // Host "foo bar"
    function values() {
        const results = [];
        let val = '';
        let quoted = false;
        let escaped = false;
        while (chr && !RE_LINE_BREAK.test(chr)) {
            if (escaped) {
                val += chr === '"' ? chr : `\\${chr}`;
                escaped = false;
            }
            else if (chr === '"') {
                quoted = !quoted;
            }
            else if (chr === '\\') {
                escaped = true;
            }
            else if (quoted) {
                val += chr;
            }
            else if (/[ \t]/.test(chr)) {
                if (val) {
                    results.push(val);
                    val = '';
                }
                // otherwise ignore the space
            }
            else {
                val += chr;
            }
            chr = next();
        }
        if (quoted || escaped) {
            throw new Error(`Unexpected line break at ${results.concat(val).join(' ')}`);
        }
        if (val)
            results.push(val);
        return results.length > 1 ? results : results[0];
    }
    function directive() {
        const type = LineType.DIRECTIVE;
        const param = parameter();
        // Host "foo bar" baz
        const multiple = RE_MULTI_VALUE_DIRECTIVE.test(param);
        const result = {
            type,
            param,
            separator: separator(),
            quoted: !multiple && chr === '"',
            value: multiple ? values() : value(),
            before: '',
            after: '',
        };
        if (!result.quoted)
            delete result.quoted;
        if (/^Match$/i.test(param)) {
            const criteria = {};
            if (typeof result.value === 'string') {
                result.value = [result.value];
            }
            let i = 0;
            while (i < result.value.length) {
                const keyword = result.value[i];
                switch (keyword.toLowerCase()) {
                    case 'all':
                    case 'canonical':
                    case 'final':
                        criteria[keyword] = [];
                        i += 1;
                        break;
                    default:
                        if (i + 1 >= result.value.length) {
                            throw new Error(`Missing value for match criteria ${keyword}`);
                        }
                        criteria[keyword] = result.value[i + 1];
                        i += 2;
                        break;
                }
            }
            result.criteria = criteria;
        }
        return result;
    }
    function line() {
        const before = space();
        const node = chr === '#' ? comment() : directive();
        const after = linebreak();
        node.before = before;
        node.after = after;
        return node;
    }
    while (chr) {
        let node = line();
        if (node.type === LineType.DIRECTIVE && RE_SECTION_DIRECTIVE.test(node.param)) {
            config = configWas;
            config.push(node);
            config = node.config = new SSHConfig();
        }
        else if (node.type === LineType.DIRECTIVE && !node.param) {
            // blank lines at file end
            if (config.length === 0) {
                configWas[configWas.length - 1].after += node.before;
            }
            else {
                config[config.length - 1].after += node.before;
            }
        }
        else {
            config.push(node);
        }
    }
    return configWas;
}
/**
 * Stringify structured object into SSH config text.
 */
export function stringify(config) {
    let str = '';
    function formatValue(value, quoted) {
        if (Array.isArray(value)) {
            return value.map(chunk => formatValue(chunk, RE_SPACE.test(chunk))).join(' ');
        }
        return quoted ? `"${value}"` : value;
    }
    function formatDirective(line) {
        const quoted = line.quoted
            || (RE_QUOTE_DIRECTIVE.test(line.param) && RE_SPACE.test(line.value));
        const value = formatValue(line.value, quoted);
        return `${line.param}${line.separator}${value}`;
    }
    const format = line => {
        str += line.before;
        if (line.type === LineType.COMMENT) {
            str += line.content;
        }
        else if (line.type === LineType.DIRECTIVE && MULTIPLE_VALUE_PROPS.includes(line.param)) {
            [].concat(line.value).forEach(function (value, i, values) {
                str += formatDirective({ ...line, value });
                if (i < values.length - 1)
                    str += `\n${line.before}`;
            });
        }
        else if (line.type === LineType.DIRECTIVE) {
            str += formatDirective(line);
        }
        str += line.after;
        if (line.config) {
            line.config.forEach(format);
        }
    };
    config.forEach(format);
    return str;
}
