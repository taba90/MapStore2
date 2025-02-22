/*
 * Copyright 2022, GeoSolutions Sas.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree.
 */

import urlUtil from 'url';

import { head, isString, includes, castArray, sortBy, uniq } from 'lodash';
import { getLayerFromRecord as getLayerFromWMSRecord } from './WMS';
import { getMessageById } from '../../utils/LocaleUtils';
import { extractEsriReferences, extractOGCServicesReferences } from '../../utils/CatalogUtils';
import CSW from '../CSW';
import {
    validate as commonValidate,
    testService as commonTestService,
    preprocess as commonPreprocess
} from './common';

const getBaseCatalogUrl = (url) => {
    return url && url.replace(/\/csw$/, "/");
};

// Try to find thumb from dc documents works both with geonode pycsw and geosolutions-csw
const getThumb = (dc) => head(castArray(dc.references).filter((ref) => {
    return ref.scheme === "WWW:LINK-1.0-http--image-thumbnail" || ref.scheme === "thumbnail" || (ref.scheme === "WWW:DOWNLOAD-1.0-http--download" && (ref.value || "").indexOf(`${dc.identifier || ""}-thumb`) !== -1) || (ref.scheme === "WWW:DOWNLOAD-REST_MAP" && (ref.value || "").indexOf(`${dc.identifier || ""}-thumb`) !== -1);
}));

// Extract the relevant information from the wms URL for (RNDT / INSPIRE)
const extractWMSParamsFromURL = wms => {
    const lowerCaseParams = new Map(Array.from(new URLSearchParams(wms.value)).map(([key, value]) => [key.toLowerCase(), value]));
    const layerName = lowerCaseParams.get('layers');
    const wmsVersion = lowerCaseParams.get('version');
    if (layerName) {
        return {
            ...wms,
            protocol: 'OGC:WMS',
            name: layerName,
            value: `${wms.value.match( /[^\?]+[\?]+/g)}SERIVCE=WMS${wmsVersion && `&VERSION=${wmsVersion}`}`
        };
    }
    return false;
};

const getMetaDataDownloadFormat = (protocol) => {
    const formatsMap = [
        {
            protocol: 'https://registry.geodati.gov.it/metadata-codelist/ProtocolValue/www-download',
            displayValue: 'Download'
        },
        {
            protocol: 'http://www.opengis.net/def/serviceType/ogc/wms',
            displayValue: 'WMS'
        },
        {
            protocol: 'http://www.opengis.net/def/serviceType/ogc/wfs',
            displayValue: 'WFS'
        }
    ];
    return head(formatsMap.filter(item => item.protocol === protocol))?.displayValue ?? "Link";
};

const getURILinks = (metadata, locales, uriItem) => {
    let itemName = uriItem.name;
    if (itemName === undefined) {
        itemName = metadata.title ? metadata.title.join(' ') : getMessageById(locales, "catalog.notAvailable");
        const downloadFormat = getMetaDataDownloadFormat(uriItem.protocol, uriItem.value);
        itemName = `${downloadFormat ? `${itemName} - ${downloadFormat}` : itemName}`;
    }
    return (`<li><a target="_blank" href="${uriItem.value}">${itemName}</a></li>`);
};

const esriToLayer = (record, { layerBaseConfig = {} } = {}) => {
    if (!record || !record.references) {
        // we don't have a valid record so no buttons to add
        return null;
    }
    // let's extract the references we need
    const {esri} = extractEsriReferences(record);
    return {
        type: esri.type,
        url: esri.url,
        visibility: true,
        dimensions: record.dimensions || [],
        name: esri.params && esri.params.name,
        bbox: {
            crs: record.boundingBox.crs,
            bounds: {
                minx: record.boundingBox.extent[0],
                miny: record.boundingBox.extent[1],
                maxx: record.boundingBox.extent[2],
                maxy: record.boundingBox.extent[3]
            }
        },
        ...layerBaseConfig
    };

};

function toReference(layerType, data, options) {
    if (!data.name) {
        return null;
    }
    switch (layerType) {
    case 'wms':
        const urlValue = !(data.value.indexOf("http") === 0)
            ? (options && options.catalogURL || "") + "/" + data.value
            : data.value;
        return {
            type: data.protocol || data.scheme,
            url: urlValue,
            SRS: [],
            params: {
                name: data.name
            }
        };
    case 'arcgis':
        return {
            type: 'arcgis',
            url: data.value,
            SRS: [],
            params: {
                name: data.name
            }
        };
    default:
        return null;
    }
}

function getLayerReferenceFromDc(dc, options) {
    const URI = dc?.URI && castArray(dc.URI);
    // look in URI objects for wms and thumbnail
    if (URI) {
        const wms = head(URI.map( uri => {
            if (uri.protocol) {
                if (uri.protocol.match(/^OGC:WMS-(.*)-http-get-map/g) || uri.protocol.match(/^OGC:WMS/g) ) {
                    /** wms protocol params are explicitly defined as attributes (INSPIRE)*/
                    return uri;
                }
                if (uri.protocol.match(/serviceType\/ogc\/wms/g)) {
                    /** wms protocol params must be extracted from the element text (RNDT / INSPIRE) */
                    return extractWMSParamsFromURL(uri);
                }
            }
            return false;
        }).filter(item => item));
        if (wms) {
            return toReference('wms', wms, options);
        }
    }
    // look in references objects
    if (dc?.references?.length) {
        const refs = castArray(dc.references);
        const wms = head(refs.filter((ref) => { return ref.scheme && (ref.scheme.match(/^OGC:WMS-(.*)-http-get-map/g) || ref.scheme === "OGC:WMS"); }));
        if (wms) {
            let urlObj = urlUtil.parse(wms.value, true);
            let layerName = urlObj.query && urlObj.query.layers || dc.alternative;
            return toReference('wms', { ...wms, name: layerName }, options);
        }
        // checks for esri arcgis in geonode csw
        const esri = head(refs.filter((ref) => { return ref.scheme && ref.scheme === "WWW:DOWNLOAD-REST_MAP"; }));
        if (esri) {
            return toReference('arcgis', { ...esri, name: dc.alternative }, options);
        }
    }
    return null;
}

function getThumbnailFromDc(dc, options) {
    const URI = dc?.URI && castArray(dc.URI);
    let thumbURL;
    if (URI) {
        const thumb = head(URI.filter(uri => uri.name === 'thumbnail')) || head(URI.filter(uri => !uri.name && uri.protocol?.indexOf('image/') > -1));
        thumbURL = thumb ? thumb.value : null;
    }
    if (!thumbURL && dc && dc.references) {
        const thumb = getThumb(dc);
        if (thumb) {
            thumbURL = thumb.value;
        }
    }
    if (thumbURL) {
        const absolute = (thumbURL.indexOf("http") === 0);
        if (!absolute) {
            thumbURL = (getBaseCatalogUrl(options && options.url) || "") + thumbURL;
        }
    }
    return thumbURL;
}

const recordToLayer = (record, options) => {
    switch (record.layerType) {
    case 'wms':
        return getLayerFromWMSRecord(record, options);
    case 'esri':
        return esriToLayer(record, options);
    default:
        return null;
    }
};

export const preprocess = commonPreprocess;
export const validate = commonValidate;
export const testService = commonTestService({ parseUrl: CSW.parseUrl });
export const textSearch = CSW.textSearch;
export const getCatalogRecords = (records, options, locales) => {
    let result = records;
    // let searchOptions = catalog.searchOptions;
    if (result && result.records) {
        return result.records.map((record) => {
            const dc = record.dc;
            let references = [];

            // extract get capabilities references and add them to the final references
            if (dc && dc.references) {
                // make sure we have an array of references
                let rawReferences = Array.isArray(dc.references) ? dc.references : [dc.references];
                rawReferences.filter((reference) => {
                    // filter all references that correspond to a get capabilities reference
                    return reference.scheme.indexOf("http-get-capabilities") > -1;
                }).forEach((reference) => {
                    // a get capabilities reference should be absolute and filter by the layer name
                    let referenceUrl = reference.value.indexOf("http") === 0 ? reference.value
                        : (options && options.catalogURL || "") + "/" + reference.value;
                    // add the references to the final list
                    references.push({
                        type: reference.scheme,
                        url: referenceUrl
                    });
                });
            }

            const layerReference = getLayerReferenceFromDc(dc, options);
            if (layerReference) {
                references.push(layerReference);
            }

            // create the references array (now only wms is supported)
            let metadata = {boundingBox: record.boundingBox && record.boundingBox.extent && castArray(record.boundingBox.extent.join(","))};
            if (dc) {
                // parsing all it comes from the csw service
                metadata = {...metadata, ...sortBy(Object.keys(dc)).reduce((p, c) => ({...p, [c]: uniq(castArray(dc[c]))}), {})};
            }
            // parsing URI
            if (dc && dc.URI && castArray(dc.URI) && castArray(dc.URI).length) {
                metadata = {...metadata, uri: ["<ul>" + castArray(dc.URI).map(getURILinks.bind(this, metadata, locales)).join("") + "</ul>"]};
            }
            if (dc && dc.subject && castArray(dc.subject) && castArray(dc.subject).length) {
                metadata = {...metadata, subject: ["<ul>" + castArray(dc.subject).map(s => `<li>${s}</li>`).join("") + "</ul>"]};
            }
            if (references && castArray(references).length ) {
                metadata = {...metadata, references: ["<ul>" + castArray(references).map(ref => `<li><a target="_blank" href="${ref.url}">${ref.params && ref.params.name || ref.url}</a></li>`).join("") + "</ul>"]
                };
            } else {
                // in order to use a default value
                // we need to not push undefined/empty matadata
                delete metadata.references;
            }

            if (dc && dc.temporal) {
                let elements = isString(dc.temporal) ? dc.temporal.split("; ") : [];
                if (elements.length) {
                    // finding scheme or using default
                    let scheme = elements.filter(e => e.indexOf("scheme=") !== -1).map(e => {
                        const equalIndex = e.indexOf("=");
                        const value = e.substr(equalIndex + 1, e.length - 1);
                        return value;
                    });
                    scheme = scheme.length ? scheme[0] : "W3C-DTF";
                    let temporal = elements
                        .filter(e => e.indexOf("start=") !== -1 || e.indexOf("end=") !== -1)
                        .map(e => {
                            const equalIndex = e.indexOf("=");
                            const prop = e.substr(0, equalIndex);
                            const value = e.substr(equalIndex + 1, e.length - 1);
                            const isOnlyDateFormat = e.length - equalIndex - 1 <= 10;
                            if (includes(["start", "end"], prop) && scheme === "W3C-DTF" && !isOnlyDateFormat) {
                                return getMessageById(locales, `catalog.${prop}`) + new Date(value).toLocaleString();
                            }
                            if (includes(["start", "end"], prop)) {
                                return getMessageById(locales, `catalog.${prop}`) + value;
                            }
                            return "";
                        });
                    metadata = {...metadata, temporal: ["<ul>" + temporal.map(date => `<li>${date}</li>`).join("") + "</ul>"]};
                }
            }

            const parsedReferences = {
                ...extractOGCServicesReferences({ references }),
                ...extractEsriReferences({ references })
            };

            const layerType = Object.keys(parsedReferences).find(key => parsedReferences[key]);
            const ogcReferences = layerType && layerType !== 'esri'
                ? parsedReferences[layerType]
                : undefined;
            return {
                serviceType: 'csw',
                layerType,
                isValid: !!layerType,
                boundingBox: record.boundingBox,
                description: dc && isString(dc.abstract) && dc.abstract || '',
                layerOptions: options && options.layerOptions || {},
                identifier: dc && isString(dc.identifier) && dc.identifier || '',
                references: references,
                thumbnail: getThumbnailFromDc(dc, options),
                title: dc && isString(dc.title) && dc.title || '',
                tags: dc && dc.tags || '',
                metadata,
                capabilities: record.capabilities,
                ogcReferences
            };
        });
    }
    return null;
};

export const getLayerFromRecord = (record, options, asPromise) => {
    const layer = recordToLayer(record, options);
    return asPromise ? Promise.resolve(layer) : layer;
};
