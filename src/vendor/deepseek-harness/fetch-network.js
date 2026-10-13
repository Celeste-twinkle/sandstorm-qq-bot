// Adapted from deepseek-ai/deepseek-harness @ d743267388641bc76f17c45ce8b4c231aed1d32c.
// Copyright (c) 2026 DeepSeek. MIT; see LICENSE and VENDOR-NOTES.md.
const { lookup: systemLookup } = require('node:dns/promises');
const { isIP } = require('node:net');
const ipaddr = require('ipaddr.js');
const { WebError } = require('./runtime');
const RFC6052_PREFIX_LENGTHS = [
    32,
    40,
    48,
    56,
    64,
    96
];
const IPV4ONLY_DISCOVERY_HOST = 'ipv4only.arpa';
const IPV4ONLY_SENTINELS = new Set([
    '192.0.0.170',
    '192.0.0.171'
]);
function isPublicIpAddress(input) {
    let parsed;
    try {
        parsed = ipaddr.parse(stripIpv6Brackets(input));
    } catch  {
        return false;
    }
    if (parsed instanceof ipaddr.IPv4) return parsed.range() === 'unicast';
    if (parsed.isIPv4MappedAddress()) return parsed.toIPv4Address().range() === 'unicast';
    return parsed.range() === 'unicast';
}
async function resolvePublicAddresses(hostname, signal, resolver = systemLookup) {
    const unbracketed = stripIpv6Brackets(hostname);
    const literalFamily = isIP(unbracketed);
    const resolved = literalFamily === 0 ? await raceWithSignal(resolver(unbracketed, {
        all: true,
        order: 'verbatim'
    }), signal) : [
        {
            address: unbracketed,
            family: literalFamily
        }
    ];
    if (resolved.length === 0) {
        throw new WebError(`hostname "${hostname}" resolved to no addresses`, 'WEB_PROVIDER_ERROR');
    }
    const hasIpv6 = resolved.some((entry)=>entry.family === 6 && isIP(entry.address) === 6);
    const nat64Prefixes = hasIpv6 ? await discoverNat64Prefixes(signal, resolver) : [];
    const addresses = [];
    for (const entry of resolved){
        if (entry.family !== 4 && entry.family !== 6 || isIP(entry.address) !== entry.family) {
            throw new WebError(`hostname "${hostname}" resolved to an invalid IP address`, 'WEB_PROVIDER_ERROR');
        }
        if (!isPublicIpAddress(entry.address)) {
            throw new WebError(`URL hostname "${hostname}" resolves to a non-public IP address`, 'WEB_BLOCKED_URL');
        }
        const translatedIpv4 = translatedIpv4Address(entry.address, nat64Prefixes);
        if (translatedIpv4 !== undefined && !isPublicIpAddress(translatedIpv4)) {
            throw new WebError(`URL hostname "${hostname}" resolves through NAT64 to a non-public IPv4 address`, 'WEB_BLOCKED_URL');
        }
        addresses.push({
            address: entry.address,
            family: entry.family
        });
    }
    return addresses;
}
async function discoverNat64Prefixes(signal, resolver) {
    const discovered = await raceWithSignal(resolver(IPV4ONLY_DISCOVERY_HOST, {
        all: true,
        order: 'verbatim'
    }), signal);
    const prefixes = [];
    const seen = new Set();
    for (const entry of discovered){
        if (entry.family !== 6 || isIP(entry.address) !== 6) continue;
        const bytes = ipaddr.parse(entry.address).toByteArray();
        for (const length of RFC6052_PREFIX_LENGTHS){
            const embedded = embeddedIpv4Address(bytes, length);
            if (embedded === undefined || !IPV4ONLY_SENTINELS.has(embedded)) continue;
            const prefixBytes = bytes.slice(0, length / 8);
            const key = `${String(length)}:${prefixBytes.join('.')}`;
            if (seen.has(key)) continue;
            seen.add(key);
            prefixes.push({
                bytes: prefixBytes,
                length
            });
        }
    }
    return prefixes;
}
function translatedIpv4Address(input, prefixes) {
    if (isIP(input) !== 6) return undefined;
    const bytes = ipaddr.parse(input).toByteArray();
    for (const prefix of prefixes){
        if (!prefix.bytes.every((byte, index)=>bytes[index] === byte)) continue;
        const embedded = embeddedIpv4Address(bytes, prefix.length);
        if (embedded !== undefined) return embedded;
    }
    return undefined;
}
function embeddedIpv4Address(bytes, prefixLength) {
    if (prefixLength === 96) return bytes.slice(12, 16).join('.');
    if (bytes[8] !== 0) return undefined;
    const prefixBytes = prefixLength / 8;
    const beforeReservedOctet = 8 - prefixBytes;
    const ipv4 = [
        ...bytes.slice(prefixBytes, prefixBytes + beforeReservedOctet),
        ...bytes.slice(9, 9 + 4 - beforeReservedOctet)
    ];
    return ipv4.join('.');
}
function isNonPublicIpLiteral(hostname) {
    const unbracketed = stripIpv6Brackets(hostname);
    return isIP(unbracketed) !== 0 && !isPublicIpAddress(unbracketed);
}
async function requestPinned(url, addresses, headers, signal) {
    const { Agent, fetch } = require('undici');
    const dispatcher = new Agent({
        autoSelectFamily: true,
        connect: {
            lookup: createPinnedLookup(addresses)
        }
    });
    try {
        const response = await fetch(url, {
            method: 'GET',
            redirect: 'manual',
            headers,
            signal,
            dispatcher
        });
        return {
            response,
            close: async ()=>{
                await dispatcher.close();
            }
        };
    } catch (error) {
        await dispatcher.close();
        throw error;
    }
}
async function requestVia(dispatcher, url, headers, signal) {
    const { fetch } = require('undici');
    const response = await fetch(url, {
        method: 'GET',
        redirect: 'manual',
        headers,
        signal,
        dispatcher
    });
    return {
        response,
        close: ()=>Promise.resolve()
    };
}
const publicHttpNetwork = {
    resolve: resolvePublicAddresses,
    request: requestPinned,
    requestVia
};
function createPinnedLookup(addresses) {
    return (hostname, options, callback)=>{
        const family = typeof options.family === 'number' ? options.family : options.family === 'IPv4' ? 4 : options.family === 'IPv6' ? 6 : 0;
        const eligible = family === 0 ? addresses : addresses.filter((address)=>address.family === family);
        const selected = eligible[0];
        if (selected === undefined) {
            const error = Object.assign(new Error(`no validated address for ${hostname} in family ${family}`), {
                code: 'ENOTFOUND',
                hostname
            });
            callback(error, options.all === true ? [] : '', family);
            return;
        }
        if (options.all === true) {
            callback(null, eligible.map((address)=>({
                    ...address
                })));
            return;
        }
        callback(null, selected.address, selected.family);
    };
}
function raceWithSignal(promise, signal) {
    const abortError = ()=>new Error('web fetch aborted during hostname resolution', {
            cause: signal.reason
        });
    if (signal.aborted) return Promise.reject(abortError());
    return new Promise((resolve, reject)=>{
        const abort = ()=>{
            reject(abortError());
        };
        signal.addEventListener('abort', abort, {
            once: true
        });
        promise.then(resolve, reject).finally(()=>{
            signal.removeEventListener('abort', abort);
        });
    });
}
function stripIpv6Brackets(hostname) {
    return hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
}

module.exports = { publicHttpNetwork, isPublicIpAddress, resolvePublicAddresses, createPinnedLookup, isNonPublicIpLiteral };
