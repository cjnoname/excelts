export const dtMatcher = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[.]\d{3}Z$/;

export function fix(o) {
  // clone the object and replace any date-like strings with new Date()
  let clone;
  if (o instanceof Array) {
    clone = [];
  } else if (typeof o === "object") {
    clone = {};
  } else if (typeof o === "string" && dtMatcher.test(o)) {
    return new Date(o);
  } else {
    return o;
  }
  if (Array.isArray(o)) {
    o.forEach((value, index) => {
      if (value !== undefined) {
        clone[index] = fix(value);
      }
    });
  } else {
    Object.keys(o).forEach(name => {
      const value = o[name];
      if (value !== undefined) {
        clone[name] = fix(value);
      }
    });
  }
  return clone;
}

export function concatenateFormula(...args) {
  const values = args.map(value => `"${value}"`);
  return {
    formula: `CONCATENATE(${values.join(",")})`
  };
}
