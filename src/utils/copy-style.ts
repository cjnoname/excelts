interface StyleObject {
  [key: string]: any;
}

const oneDepthCopy = (obj: StyleObject, nestKeys: string[]): StyleObject => ({
  ...obj,
  ...nestKeys.reduce((memo: StyleObject, key: string) => {
    if (obj[key]) {
      memo[key] = { ...obj[key] };
    }
    return memo;
  }, {})
});

const setIfExists = (
  src: StyleObject,
  dst: StyleObject,
  key: string,
  nestKeys: string[] = []
): void => {
  if (src[key]) {
    dst[key] = oneDepthCopy(src[key], nestKeys);
  }
};

const isEmptyObj = (obj: StyleObject): boolean => Object.keys(obj).length === 0;

const copyStyle = (style: StyleObject | null | undefined): StyleObject | null | undefined => {
  if (!style) {
    return style;
  }
  if (isEmptyObj(style)) {
    return {};
  }

  const copied: StyleObject = { ...style };

  setIfExists(style, copied, "font", ["color"]);
  setIfExists(style, copied, "alignment");
  setIfExists(style, copied, "protection");
  if (style.border) {
    setIfExists(style, copied, "border");
    setIfExists(style.border, copied.border, "top", ["color"]);
    setIfExists(style.border, copied.border, "left", ["color"]);
    setIfExists(style.border, copied.border, "bottom", ["color"]);
    setIfExists(style.border, copied.border, "right", ["color"]);
    setIfExists(style.border, copied.border, "diagonal", ["color"]);
  }

  if (style.fill) {
    setIfExists(style, copied, "fill", ["fgColor", "bgColor", "center"]);
    if (style.fill.stops) {
      copied.fill.stops = style.fill.stops.map((s: StyleObject) => oneDepthCopy(s, ["color"]));
    }
  }

  return copied;
};

export { copyStyle };
