const args = ((expand) =>
  process.argv.slice(2).reduce(
    (acc, str) => {
      if (str[0] != "-") {
        acc.rest.push(str);
      } else {
        const { dashes, negation, key, val } = str.match(
          /(?<dashes>-+)(?<negation>no-)?(?<key>[^=]*)(?:=(?<val>.*))?/
        )?.groups || { dashes:"-", negation: "", key: str, val: "" };
        const keyword = dashes.length == 1 && key in expand ? expand[key] : key;
        const value = negation
          ? false
          : typeof val === 'undefined' || val === ""
          ? true
          : val.toLowerCase() === "true"
          ? true
          : val.toLowerCase() === "false"
          ? false
          : val;
        acc[keyword] = value;
      }
      return acc;
    },
    {
      _: {
        executable: process.argv[0],
        path: process.argv[1],
      },
      rest: [],
    }
  ))({ w: "watch" });

console.log(args);
