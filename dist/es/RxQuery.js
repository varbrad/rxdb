function _asyncToGenerator(fn) { return function () { var gen = fn.apply(this, arguments); return new Promise(function (resolve, reject) { function step(key, arg) { try { var info = gen[key](arg); var value = info.value; } catch (error) { reject(error); return; } if (info.done) { resolve(value); } else { return Promise.resolve(value).then(function (value) { step("next", value); }, function (err) { step("throw", err); }); } } return step("next"); }); }; }

import deepEqual from 'deep-equal';
import MQuery from './mquery/mquery';
import clone from 'clone';

import * as util from './util';
import * as RxDocument from './RxDocument';
import * as QueryChangeDetector from './QueryChangeDetector';

let _queryCount = 0;
const newQueryID = function () {
    return ++_queryCount;
};

class RxQuery {
    constructor(op, queryObj, collection) {
        this.op = op;
        this.collection = collection;
        this.id = newQueryID();

        if (!queryObj) queryObj = this._defaultQuery();

        this.mquery = new MQuery(queryObj);

        this._queryChangeDetector = QueryChangeDetector.create(this);
        this._resultsData = null;
        this._results$ = new util.Rx.BehaviorSubject(null);
        this._observable$ = null;
        this._latestChangeEvent = -1;
        this._runningPromise = Promise.resolve(true);

        /**
         * if this is true, the results-state is not equal to the database
         * which means that the query must run agains the database again
         * @type {Boolean}
         */
        this._mustReExec = true;

        /**
         * counts how often the execution on the whole db was done
         * (used for tests and debugging)
         * @type {Number}
         */
        this._execOverDatabaseCount = 0;
    }

    _defaultQuery() {
        return {
            [this.collection.schema.primaryPath]: {}
        };
    }

    // returns a clone of this RxQuery
    _clone() {
        const cloned = new RxQuery(this.op, this._defaultQuery(), this.collection);
        cloned.mquery = this.mquery.clone();
        return cloned;
    }

    /**
     * run this query through the QueryCache
     * @return {RxQuery} can be this or another query with the equal state
     */
    _tunnelQueryCache() {
        return this.collection._queryCache.getByQuery(this);
    }

    toString() {
        if (!this.stringRep) {
            const stringObj = util.sortObject({
                op: this.op,
                options: this.mquery.options,
                _conditions: this.mquery._conditions,
                _path: this.mquery._path,
                _fields: this.mquery._fields
            }, true);
            this.stringRep = JSON.stringify(stringObj);
        }
        return this.stringRep;
    }

    /**
     * ensures that the results of this query is equal to the results which a query over the database would give
     * @return {Promise<boolean>} true if results have changed
     */
    _ensureEqual() {
        var _this = this;

        return _asyncToGenerator(function* () {

            if (_this._latestChangeEvent >= _this.collection._changeEventBuffer.counter) return false;

            let ret = false;

            // make sure it does not run in parallel
            yield _this._runningPromise;

            // console.log('_ensureEqual(' + this.toString() + ') '+ this._mustReExec);

            let resolve;
            _this._runningPromise = new Promise(function (res) {
                resolve = res;
            });

            if (!_this._mustReExec) {
                try {
                    const missedChangeEvents = _this.collection._changeEventBuffer.getFrom(_this._latestChangeEvent + 1);
                    // console.dir(missedChangeEvents);
                    _this._latestChangeEvent = _this.collection._changeEventBuffer.counter;
                    const runChangeEvents = _this.collection._changeEventBuffer.reduceByLastOfDoc(missedChangeEvents);
                    const changeResult = _this._queryChangeDetector.runChangeDetection(runChangeEvents);
                    if (!Array.isArray(changeResult) && changeResult) _this._mustReExec = true;
                    if (Array.isArray(changeResult) && !deepEqual(changeResult, _this._resultsData)) {
                        ret = true;
                        _this._setResultData(changeResult);
                    }
                } catch (e) {
                    console.error('RxQuery()._ensureEqual(): Unexpected Error:');
                    console.dir(e);
                    _this._mustReExec = true;
                }
            }

            if (_this._mustReExec) {

                // counter can change while _execOverDatabase() is running
                const latestAfter = _this.collection._changeEventBuffer.counter;

                const newResultData = yield _this._execOverDatabase();
                _this._latestChangeEvent = latestAfter;
                if (!deepEqual(newResultData, _this._resultsData)) {
                    ret = true;
                    _this._setResultData(newResultData);
                }
            }

            // console.log('_ensureEqual DONE (' + this.toString() + ')');

            resolve(true);
            return ret;
        })();
    }

    _setResultData(newResultData) {
        this._resultsData = newResultData;
        const newResults = this.collection._createDocuments(this._resultsData);
        this._results$.next(newResults);
    }

    /**
     * executes the query on the database
     * @return {Promise<{}[]>} returns new resultData
     */
    _execOverDatabase() {
        var _this2 = this;

        return _asyncToGenerator(function* () {
            _this2._execOverDatabaseCount++;
            let docsData, ret;
            switch (_this2.op) {
                case 'find':
                    docsData = yield _this2.collection._pouchFind(_this2);
                    break;
                case 'findOne':
                    docsData = yield _this2.collection._pouchFind(_this2, 1);
                    break;
                default:
                    throw new Error(`RxQuery.exec(): op (${_this2.op}) not known`);
            }

            _this2._mustReExec = false;
            return docsData;
        })();
    }

    get $() {
        var _this3 = this;

        if (!this._observable$) {

            const res$ = this._results$.mergeMap((() => {
                var _ref = _asyncToGenerator(function* (results) {
                    const hasChanged = yield _this3._ensureEqual();
                    if (hasChanged) return 'WAITFORNEXTEMIT';
                    return results;
                });

                return function (_x) {
                    return _ref.apply(this, arguments);
                };
            })()).filter(results => results != 'WAITFORNEXTEMIT').asObservable();

            const changeEvents$ = this.collection.$.filter(cEvent => ['INSERT', 'UPDATE', 'REMOVE'].includes(cEvent.data.op)).mergeMap((() => {
                var _ref2 = _asyncToGenerator(function* (changeEvent) {
                    return _this3._ensureEqual();
                });

                return function (_x2) {
                    return _ref2.apply(this, arguments);
                };
            })()).filter(() => false);

            this._observable$ = util.Rx.Observable.merge(res$, changeEvents$).filter(x => x != null).map(results => {
                if (this.op != 'findOne') return results;else if (results.length == 0) return null;else return results[0];
            });
        }
        return this._observable$;
    }

    toJSON() {
        if (this._toJSON) return this._toJSON;

        const primPath = this.collection.schema.primaryPath;

        const json = {
            selector: this.mquery._conditions
        };

        let options = this.mquery._optionsForExec();

        // sort
        if (options.sort) {
            const sortArray = [];
            Object.keys(options.sort).map(fieldName => {
                const dirInt = options.sort[fieldName];
                let dir = 'asc';
                if (dirInt == -1) dir = 'desc';
                const pushMe = {};
                // TODO run primary-swap somewhere else
                if (fieldName == primPath) fieldName = '_id';

                pushMe[fieldName] = dir;
                sortArray.push(pushMe);
            });
            json.sort = sortArray;
        } else {
            // sort by primaryKey as default
            // (always use _id because there is no primary-swap on json.sort)
            json.sort = [{
                _id: 'asc'
            }];
        }

        if (options.limit) {
            if (typeof options.limit !== 'number') throw new TypeError('limit() must get a number');
            json.limit = options.limit;
        }

        if (options.skip) {
            if (typeof options.skip !== 'number') throw new TypeError('skip() must get a number');
            json.skip = options.skip;
        }

        // add not-query to _id to prevend the grabbing of '_design..' docs
        // this is not the best solution because it prevents the usage of a 'language'-field
        if (!json.selector.language) json.selector.language = {};
        json.selector.language.$ne = 'query';

        // strip empty selectors
        Object.entries(json.selector).forEach(entry => {
            const key = entry[0];
            const select = entry[1];
            if (typeof select === 'object' && Object.keys(select) == 0) delete json.selector[key];
        });

        // primary swap
        if (primPath != '_id' && json.selector[primPath]) {
            // selector
            json.selector._id = json.selector[primPath];
            delete json.selector[primPath];
        }

        this._toJSON = json;
        return this._toJSON;
    }

    /**
     * get the key-compression version of this query
     * @return {{selector: {}, sort: []}} compressedQuery
     */
    keyCompress() {
        return this.collection._keyCompressor.compressQuery(this.toJSON());
    }

    /**
     * deletes all found documents
     * @return {Promise(RxDocument|RxDocument[])} promise with deleted documents
     */
    remove() {
        var _this4 = this;

        return _asyncToGenerator(function* () {
            const docs = yield _this4.exec();
            if (Array.isArray(docs)) {
                yield Promise.all(docs.map(function (doc) {
                    return doc.remove();
                }));
            } else {
                // via findOne()
                yield docs.remove();
            }
            return docs;
        })();
    }

    exec() {
        var _this5 = this;

        return _asyncToGenerator(function* () {
            return yield _this5.$.first().toPromise();
        })();
    }

    /**
     * regex cannot run on primary _id
     * @link https://docs.cloudant.com/cloudant_query.html#creating-selector-expressions
     */
    regex(params) {
        if (this.mquery._path == this.collection.schema.primaryPath) throw new Error(`You cannot use .regex() on the primary field '${this.mquery._path}'`);

        this.mquery.regex(params);
        return this;
    }

    /**
     * make sure it searches index because of pouchdb-find bug
     * @link https://github.com/nolanlawson/pouchdb-find/issues/204
     */
    sort(params) {
        const clonedThis = this._clone();

        // workarround because sort wont work on unused keys
        if (typeof params !== 'object') {
            const checkParam = params.charAt(0) == '-' ? params.substring(1) : params;
            if (!clonedThis.mquery._conditions[checkParam]) {
                const schemaObj = clonedThis.collection.schema.getSchemaByObjectPath(checkParam);
                if (schemaObj && schemaObj.type == 'integer')
                    // TODO change back to -Infinity when issue resolved
                    // @link https://github.com/pouchdb/pouchdb/issues/6454
                    clonedThis.mquery.where(checkParam).gt(-9999999999999999999999999999); // -Infinity does not work since pouchdb 6.2.0
                else clonedThis.mquery.where(checkParam).gt(null);
            }
        } else {
            Object.keys(params).filter(k => !clonedThis.mquery._conditions[k] || !clonedThis.mquery._conditions[k].$gt).forEach(k => {
                const schemaObj = clonedThis.collection.schema.getSchemaByObjectPath(k);
                if (schemaObj.type == 'integer')
                    // TODO change back to -Infinity when issue resolved
                    // @link https://github.com/pouchdb/pouchdb/issues/6454
                    clonedThis.mquery.where(k).gt(-9999999999999999999999999999); // -Infinity does not work since pouchdb 6.2.0

                else clonedThis.mquery.where(k).gt(null);
            });
        }
        clonedThis.mquery.sort(params);
        return clonedThis._tunnelQueryCache();
    }

    limit(amount) {
        if (this.op == 'findOne') throw new Error('.limit() cannot be called on .findOne()');else {
            const clonedThis = this._clone();
            clonedThis.mquery.limit(amount);
            return clonedThis._tunnelQueryCache();
        }
    }
}

// tunnel the proto-functions of mquery to RxQuery
const protoMerge = function (rxQueryProto, mQueryProto) {
    Object.keys(mQueryProto).filter(attrName => !attrName.startsWith('_')).filter(attrName => !rxQueryProto[attrName]).forEach(attrName => {
        rxQueryProto[attrName] = function (p1) {
            const clonedThis = this._clone();
            clonedThis.mquery[attrName](p1);
            return clonedThis._tunnelQueryCache();
        };
    });
};

let protoMerged = false;
export function create(op, queryObj, collection) {
    if (queryObj && typeof queryObj !== 'object') throw new TypeError('query must be an object');
    if (Array.isArray(queryObj)) throw new TypeError('query cannot be an array');

    const ret = new RxQuery(op, queryObj, collection);

    if (!protoMerged) {
        protoMerged = true;
        protoMerge(Object.getPrototypeOf(ret), Object.getPrototypeOf(ret.mquery));
    }

    return ret;
}