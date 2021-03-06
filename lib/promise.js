/*
 * Copyright 2009-2011 Mozilla Foundation and contributors
 * Licensed under the New BSD license. See LICENSE.txt or:
 * http://opensource.org/licenses/BSD-3-Clause
 */


/**
 * Create an unfulfilled promise
 * @param trace A debugging value
 * @constructor
 */
function Promise(trace) {
  this._status = Promise.PENDING;
  this._value = undefined;
  this._onSuccessHandlers = [];
  this._onErrorHandlers = [];

  // Debugging help
  this._id = Promise._nextId++;
  Promise._outstanding[this._id] = this;
  this._trace = trace;
}

/**
 * We give promises and ID so we can track which are outstanding
 */
Promise._nextId = 0;

/**
 * Outstanding promises. Handy list for debugging only
 */
Promise._outstanding = [];

/**
 * Recently resolved promises. Also for debugging only
 */
Promise._recent = [];

/**
 * A promise can be in one of 2 states.
 * The ERROR and SUCCESS states are terminal, the PENDING state is the only
 * start state.
 */
Promise.ERROR = -1;
Promise.PENDING = 0;
Promise.SUCCESS = 1;

/**
 * Yeay for RTTI
 */
Promise.prototype.isPromise = true;

/**
 * Have we either been resolve()ed or reject()ed?
 */
Promise.prototype.isComplete = function() {
  return this._status != Promise.PENDING;
};

/**
 * Have we resolve()ed?
 */
Promise.prototype.isResolved = function() {
  return this._status == Promise.SUCCESS;
};

/**
 * Have we reject()ed?
 */
Promise.prototype.isRejected = function() {
  return this._status == Promise.ERROR;
};

/**
 * Take the specified action of fulfillment of a promise, and (optionally)
 * a different action on promise rejection
 */
Promise.prototype.then = function(onSuccess, onError) {
  if (typeof onSuccess === 'function') {
    if (this._status === Promise.SUCCESS) {
      onSuccess.call(null, this._value);
    }
    else if (this._status === Promise.PENDING) {
      this._onSuccessHandlers.push(onSuccess);
    }
  }

  if (typeof onError === 'function') {
    if (this._status === Promise.ERROR) {
      onError.call(null, this._value);
    }
    else if (this._status === Promise.PENDING) {
      this._onErrorHandlers.push(onError);
    }
  }

  return this;
};

/**
 * Like then() except that rather than returning <tt>this</tt> we return
 * a promise which resolves when the original promise resolves
 */
Promise.prototype.chainPromise = function(onSuccess) {
  var chain = new Promise();
  chain._chainedFrom = this;
  this.then(function(data) {
    try {
      chain.resolve(onSuccess(data));
    }
    catch (ex) {
      chain.reject(ex);
    }
  }, function(ex) {
    chain.reject(ex);
  });
  return chain;
};

/**
 * Supply the fulfillment of a promise
 */
Promise.prototype.resolve = function(data) {
  return this._complete(this._onSuccessHandlers,
                        Promise.SUCCESS, data, 'resolve');
};

/**
 * Renege on a promise
 */
Promise.prototype.reject = function(data) {
  return this._complete(this._onErrorHandlers, Promise.ERROR, data, 'reject');
};

/**
 * Internal method to be called on resolve() or reject()
 */
Promise.prototype._complete = function(list, status, data, name) {
  // Complain if we've already been completed
  if (this._status != Promise.PENDING) {
    Promise._error('Promise complete. Attempted ' + name + '() with ', data);
    Promise._error('Prev status = ', this._status, ', value = ', this._value);
    throw new Error('Promise already complete');
  }
  else if (list.length == 0 && status == Promise.ERROR) {
    // Complain if a rejection is ignored
    // (this is the equivalent of an empty catch-all clause)
    Promise._error("Promise rejection ignored and silently dropped");
    Promise._error(data);
    var frame;
    if (this._trace) {
      Promise._error("Original trace");
      Promise._error(this._trace);
    }
    if (data.stack) {
      // This is an exception or an exception-like value
      Promise._error("Printing original stack");
      for (frame = data.stack; frame; frame = frame.caller) {
        Promise._error(frame);
      }
    }
    else if (data.fileName && data.lineNumber) {
      Promise._error("Error originating at " + data.fileName + ", line "
           + data.lineNumber);
    }
    else if (typeof Components !== "undefined") {
      try {
        if (Components.stack) {
          Promise._error("Original stack not available. Printing current stack");
          for (frame = Components.stack; frame; frame = frame.caller) {
            Promise._error(frame);
          }
        }
      }
      catch (ex) {
        // Ignore failure to read Components.stack
      }
    }
  }

  Promise._setTimeout(function() {
    this._status = status;
    this._value = data;

    // Call all the handlers, and then delete them
    list.forEach(function(handler) {
      handler.call(null, this._value);
    }, this);
    delete this._onSuccessHandlers;
    delete this._onErrorHandlers;

    // Remove the given {promise} from the _outstanding list, and add it to the
    // _recent list, pruning more than 20 recent promises from that list
    delete Promise._outstanding[this._id];
    // The web version of this code includes this very useful debugging aid,
    // however there is concern that it will create a memory leak, so we leave it
    // out when embedded in Mozilla.
    //*
    Promise._recent.push(this);
    while (Promise._recent.length > 20) {
      Promise._recent.shift();
    }
    //*/
  }.bind(this), 1);

  return this;
};

/**
 * Trap errors.
 *
 * This function serves as an asynchronous counterpart to |catch|.
 *
 * Example:
 *  myPromise.chainPromise(a) // May reject
 *           .chainPromise(b) // May reject
 *           .chainPromise(c) // May reject
 *           .trap(d)         // Catch any rejection from a, b or c
 *           .chainPromise(e) // If either a, b and c or
 *                            // d has resolved, execute
 *
 * Scenario 1:
 *   If a, b, c resolve, e is executed as if d had not been added.
 *
 * Scenario 2:
 *   If a, b or c rejects, d is executed. If d resolves, we proceed
 *   with e as if nothing had happened. Otherwise, we proceed with
 *   the rejection of d.
 *
 * @param {Function} aTrap Called if |this| promise is rejected,
 *   with one argument: the rejection.
 * @return {Promise} A new promise. This promise resolves if all
 *   previous promises have resolved or if |aTrap| succeeds.
 */
Promise.prototype.trap = function(aTrap) {
  var promise = new Promise();
  var resolve = Promise.prototype.resolve.bind(promise);
  var reject = function(aRejection) {
    try {
      //Attempt to handle issue
      var result = aTrap.call(aTrap, aRejection);
      promise.resolve(result);
    } catch (x) {
      promise.reject(x);
    }
  };
  this.then(resolve, reject);
  return promise;
};

/**
 * Execute regardless of errors.
 *
 * This function serves as an asynchronous counterpart to |finally|.
 *
 * Example:
 *  myPromise.chainPromise(a) // May reject
 *           .chainPromise(b) // May reject
 *           .chainPromise(c) // May reject
 *           .always(d)       // Executed regardless
 *           .chainPromise(e)
 *
 * Whether |a|, |b| or |c| resolve or reject, |d| is executed.
 *
 * @param {Function} aTrap Called regardless of whether |this|
 *   succeeds or fails.
 * @return {Promise} A new promise. This promise holds the same
 *   resolution/rejection as |this|.
 */
Promise.prototype.always = function(aTrap) {
  var promise = new Promise();
  var resolve = function(result) {
    try {
      aTrap.call(aTrap);
      promise.resolve(result);
    } catch (x) {
      promise.reject(x);
    }
  };
  var reject = function(result) {
    try {
      aTrap.call(aTrap);
      promise.reject(result);
    } catch (x) {
      promise.reject(result);
    }
  };
  this.then(resolve, reject);
  return promise;
};

/**
 * Minimal debugging.
 */
Promise.prototype.toString = function() {
  return "[Promise " + this._id + "]";
};

/**
 * Takes an array of promises and returns a promise that that is fulfilled once
 * all the promises in the array are fulfilled
 * @param promiseList The array of promises
 * @return the promise that is fulfilled when all the array is fulfilled
 */
Promise.group = function(promiseList) {
  if (!Array.isArray(promiseList)) {
    promiseList = Array.prototype.slice.call(arguments);
  }

  // If the original array has nothing in it, return now to avoid waiting
  if (promiseList.length === 0) {
    return new Promise().resolve([]);
  }

  var groupPromise = new Promise();
  var results = [];
  var fulfilled = 0;

  var onSuccessFactory = function(index) {
    return function(data) {
      results[index] = data;
      fulfilled++;
      // If the group has already failed, silently drop extra results
      if (groupPromise._status !== Promise.ERROR) {
        if (fulfilled === promiseList.length) {
          groupPromise.resolve(results);
        }
      }
    };
  };

  promiseList.forEach(function(promise, index) {
    var onSuccess = onSuccessFactory(index);
    var onError = groupPromise.reject.bind(groupPromise);
    promise.then(onSuccess, onError);
  });

  return groupPromise;
};

/**
 * Executes a code snippet or a function after specified delay.
 * @param callback is the function you want to execute after the delay.
 * @param delay is the number of milliseconds that the function call should
 * be delayed by. Note that the actual delay may be longer, see Notes below.
 * @return the ID of the timeout
 */
Promise._setTimeout = function(callback, delay) {
  return window.setTimeout(callback, delay);
};

/**
 * This implementation of promise also runs in a browser.
 * Promise._error allows us to redirect error messages to the console with
 * minimal changes.
 */
Promise._error = console.warn.bind(console);


if (typeof exports !== 'undefined') {
  exports.Promise = Promise;
}
