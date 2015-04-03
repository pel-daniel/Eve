var Indexing = (function() {
  exports = {};

  function arraysIdentical(a, b) {
    var i = a.length;
    if (!b || i != b.length) return false;
    while (i--) {
      if(a[i] && a[i].constructor === Array) {
        if(!arraysIdentical(a[i], b[i])) return false;
        continue;
      }
      if (a[i] !== b[i]) return false;
    }
    return true;
  }

  exports.arraysIdentical = arraysIdentical;

  function indexOfArray(haystack, needle) {
    var result = -1;
    for(var haystackIx = 0, haystackLen = haystack.length; haystackIx < haystackLen; haystackIx++) {
      var cur = haystack[haystackIx];
      if(arraysIdentical(cur, needle)) {
        result = haystackIx;
        break;
      }
    }
    return result;
  }

  function applyTableDiff(table, adds, removes) {
    for(var remIx = 0, remLen = removes.length; remIx < remLen; remIx++) {
      var rem = removes[remIx];
      var foundIx = indexOfArray(table, rem);
      if(foundIx !== -1) {
        table.splice(foundIx, 1);
      }
    }
    for(var addIx = 0, addLen = adds.length; addIx < addLen; addIx++) {
      var add = adds[addIx];
      var foundIx = indexOfArray(table, add);
      if(foundIx !== -1) continue;
      table.push(add);
    }
  }

  function Indexer() {
    this.tables = {};
    this.indexes = {};
    this.tableToIndex = {};
  }

  Indexer.prototype = {
    clear: function() {
      var final = {};
      for(var table in this.tables) {
        this.handleDiff(table, [], this.tables[table]);
      }
      return {changes: final};
    },
    load: function(pickle) {
      var diffs = {};
      for(var table in pickle) {
        this.handleDiff(table, pickle[table]);
      }
    },
    handleDiff: function(table, adds, removes) {
      var safeAdds = adds || [];
      var safeRemoves = removes || [];
      var indexes = this.tableToIndex[table] || [];
      for(var ix = 0, len = indexes.length; ix < len; ix++) {
        var cur = indexes[ix];
        cur.index = cur.indexer(cur.index, safeAdds, safeRemoves);
      }
      if(!this.tables[table]) {
        this.tables[table] = [];
      }
      applyTableDiff(this.tables[table], safeAdds, safeRemoves);
    },
    dumpMapDiffs: function() {
      var final = {};
      for(var table in this.tables) {
        final[table] = {inserted: this.tables[table], removed: []};
      }
      return {changes: final};
    },
    handleMapDiffs: function(diffs) {
      for(var table in diffs) {
        var diff = diffs[table];
        if(diff.inserted.length || diff.removed.length) {
          this.handleDiff(table, diff.inserted, diff.removed);
        }
      }
    },
    handleDiffs: function(diffs) {
      var diffTables = {};
      var adds = {};
      var removes = {};
      for(var diffIx = 0, diffLen = diffs.length; diffIx < diffLen; diffIx++) {
        var cur = diffs[diffIx];
        var table = cur[0];
        var action = cur[1];
        var fact = cur[2];
        diffTables[table] = true;
        if(action === "inserted") {
          if(!adds[table]) { adds[table] = []; }
          adds[table].push(fact);
        } else {
          if(!removes[table]) { removes[table] = []; }
          removes[table].push(fact);
        }
      }
      for(var table in diffTables) {
        this.handleDiff(table, adds[table], removes[table]);
      }
    },
    addIndex: function(name, table, indexer) {
      var index = {index: {}, indexer: indexer, table: table};
      this.indexes[name] = index;
      if(!this.tableToIndex[table]) {
        this.tableToIndex[table] = [];
      }
      this.tableToIndex[table].push(index);
      if(this.tables[table]) {
        index.index = index.indexer(index.index, this.tables[table], []);
      }
    },
    index: function(name) {
      if(this.indexes[name]) {
        return this.indexes[name].index;
      }
      return null;
    },
    facts: function(name) {
      return this.tables[name] || [];
    },
    first: function(name) {
      return this.facts(name)[0];
    }
  };

  exports.Indexer = Indexer;

  var create = {
    lookup: function(keyIxes) {
      var valueIx = keyIxes.pop();
      return function(cur, adds, removes) {
        var cursor;
        outer: for(var remIx = 0, remLen = removes.length; remIx < remLen; remIx++) {
          var rem = removes[remIx];
          cursor = cur;
          for(var ix = 0, keyLen = keyIxes.length - 1; ix < keyLen; ix++) {
            cursor = cursor[rem[keyIxes[ix]]];
            if(!cursor) continue outer;
          }
          delete cursor[rem[keyIxes[keyIxes.length - 1]]];
        }
        for(var addIx = 0, addLen = adds.length; addIx < addLen; addIx++) {
          var add = adds[addIx];
          cursor = cur;
          for(var ix = 0, keyLen = keyIxes.length - 1; ix < keyLen; ix++) {
            var next = cursor[add[keyIxes[ix]]];
            if(!next) {
              next = cursor[add[keyIxes[ix]]] = {};
            }
            cursor = next;
          }
          if(valueIx !== false) {
            cursor[add[keyIxes[keyIxes.length - 1]]] = add[valueIx];
          } else {
            cursor[add[keyIxes[keyIxes.length - 1]]] = add;
          }
        }
        return cur;
      }
    },
    collector: function(keyIxes) {
      return function(cur, adds, removes) {
        var cursor;
        outer: for(var remIx = 0, remLen = removes.length; remIx < remLen; remIx++) {
          var rem = removes[remIx];
          cursor = cur;
          for(var ix = 0, keyLen = keyIxes.length - 1; ix < keyLen; ix++) {
            cursor = cursor[rem[keyIxes[ix]]];
            if(!cursor) continue outer;
          }

          cursor[rem[keyIxes[keyIxes.length - 1]]] = cursor[rem[keyIxes[keyIxes.length - 1]]].filter(function(potential) {
            return !arraysIdentical(rem, potential);
          });
        }
        for(var addIx = 0, addLen = adds.length; addIx < addLen; addIx++) {
          var add = adds[addIx];
          cursor = cur;
          for(var ix = 0, keyLen = keyIxes.length - 1; ix < keyLen; ix++) {
            var next = cursor[add[keyIxes[ix]]];
            if(!next) {
              next = cursor[add[keyIxes[ix]]] = {};
            }
            cursor = next;
          }
          next = cursor[add[keyIxes[keyIxes.length - 1]]];
          if(!next) {
            next = cursor[add[keyIxes[keyIxes.length - 1]]] = [];
          }
          next.push(add);
        }
        return cur;
      }
    },
  };

  exports.create = create;

  return exports;
})();