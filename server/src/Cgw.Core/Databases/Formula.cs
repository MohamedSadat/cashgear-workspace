using System.Globalization;
using System.Text;

namespace Cgw.Core.Databases;

/// <summary>
/// The formula language (db/formula/): the lexer and parser (parser.ts), the checker that gives
/// every node its kind before anything is evaluated (check.ts), a database's formulas compiled in
/// dependency order with cycles found (compile.ts), and the evaluator (evaluate.ts). Kinds:
/// number, text, boolean, date, list; <c>empty</c> fits anything.
/// </summary>
public static class Formulas
{
    public const string Syntax = "formula.syntax";
    public const string UnknownProperty = "formula.unknownProperty";
    public const string UnknownFunction = "formula.unknownFunction";
    public const string TypeError = "formula.type";
    public const string Arity = "formula.arity";
    public const string Cycle = "formula.cycle";
    public const string DivideByZero = "formula.divideByZero";
    public const string Range = "formula.range";

    public sealed class FormulaException(string code) : Exception(code)
    {
        public string Code { get; } = code;
    }

    public sealed class SyntaxException(int at, string message) : Exception(message)
    {
        public int At { get; } = at;
    }

    // Nodes -----------------------------------------------------------------------------------------

    public abstract class Node
    {
        public int Start { get; set; }
        public int End { get; set; }
        /// <summary>Set by the checker.</summary>
        public string? Type { get; set; }
        public abstract Node Copy();
    }

    public sealed class Num(double value) : Node
    {
        public double Value { get; } = value;
        public override Node Copy() => new Num(Value) { Start = Start, End = End, Type = Type };
    }

    public sealed class Str(string value) : Node
    {
        public string Value { get; } = value;
        public override Node Copy() => new Str(Value) { Start = Start, End = End, Type = Type };
    }

    public sealed class Bool(bool value) : Node
    {
        public bool Value { get; } = value;
        public override Node Copy() => new Bool(Value) { Start = Start, End = End, Type = Type };
    }

    public sealed class Prop(string id) : Node
    {
        public string Id { get; } = id;
        public override Node Copy() => new Prop(Id) { Start = Start, End = End, Type = Type };
    }

    public sealed class Call(string name, List<Node> args) : Node
    {
        public string Name { get; } = name;
        public List<Node> Args { get; } = args;
        public override Node Copy() => new Call(Name, Args) { Start = Start, End = End, Type = Type };
    }

    public sealed class Unary(string op, Node arg) : Node
    {
        public string Op { get; } = op;
        public Node Arg { get; } = arg;
        public override Node Copy() => new Unary(Op, Arg) { Start = Start, End = End, Type = Type };
    }

    public sealed class Binary(string op, Node left, Node right) : Node
    {
        public string Op { get; } = op;
        public Node Left { get; } = left;
        public Node Right { get; } = right;
        public override Node Copy() => new Binary(Op, Left, Right) { Start = Start, End = End, Type = Type };
    }

    // Lexer -----------------------------------------------------------------------------------------

    public enum TokenKind { Number, String, Name, Op, End }

    public readonly record struct Token(TokenKind Kind, string Text, object? Value, int Start, int End);

    private static readonly string[] Operators = ["||", "&&", "==", "!=", "<=", ">=", "!", "<", ">", "+", "-", "*", "/", "%", "^", "(", ")", ","];

    private static bool Digit(char c) => c is >= '0' and <= '9';

    public static List<Token> Tokenize(string source)
    {
        var tokens = new List<Token>();
        var i = 0;
        while (i < source.Length)
        {
            var c = source[i];
            if (DbText.IsJsSpace(c))
            {
                i++;
                continue;
            }
            if (Digit(c))
            {
                // \d+(\.\d+)?([eE][+-]?\d+)?
                var j = i;
                while (j < source.Length && Digit(source[j])) j++;
                if (j + 1 < source.Length && source[j] == '.' && Digit(source[j + 1]))
                {
                    j++;
                    while (j < source.Length && Digit(source[j])) j++;
                }
                if (j < source.Length && source[j] is 'e' or 'E')
                {
                    var k = j + 1;
                    if (k < source.Length && source[k] is '+' or '-') k++;
                    if (k < source.Length && Digit(source[k]))
                    {
                        while (k < source.Length && Digit(source[k])) k++;
                        j = k;
                    }
                }
                var text = source[i..j];
                tokens.Add(new Token(TokenKind.Number, text, double.Parse(text, NumberStyles.Float, CultureInfo.InvariantCulture), i, j));
                i = j;
                continue;
            }
            if (c == '"')
            {
                var value = new StringBuilder();
                var j = i + 1;
                while (true)
                {
                    if (j >= source.Length) throw new SyntaxException(i, "The text is not closed");
                    var d = source[j];
                    if (d == '"') break;
                    if (d == '\\')
                    {
                        var next = j + 1 < source.Length ? source[j + 1] : '\0';
                        if (next is not ('"' or '\\')) throw new SyntaxException(j, "Unknown escape");
                        value.Append(next);
                        j += 2;
                        continue;
                    }
                    value.Append(d);
                    j++;
                }
                tokens.Add(new Token(TokenKind.String, source[i..(j + 1)], value.ToString(), i, j + 1));
                i = j + 1;
                continue;
            }
            if (char.IsAsciiLetter(c) || c == '_')
            {
                var j = i + 1;
                while (j < source.Length && (char.IsAsciiLetterOrDigit(source[j]) || source[j] == '_')) j++;
                tokens.Add(new Token(TokenKind.Name, source[i..j], null, i, j));
                i = j;
                continue;
            }
            var op = Operators.FirstOrDefault(o => i + o.Length <= source.Length && string.CompareOrdinal(source, i, o, 0, o.Length) == 0);
            if (op is null) throw new SyntaxException(i, $"Unexpected {c}");
            tokens.Add(new Token(TokenKind.Op, op, null, i, i + op.Length));
            i += op.Length;
        }
        tokens.Add(new Token(TokenKind.End, "", null, source.Length, source.Length));
        return tokens;
    }

    // Parser ----------------------------------------------------------------------------------------

    private static readonly HashSet<string> Keywords = ["true", "false", "and", "or", "not"];

    public static Node Parse(string source)
    {
        var tokens = Tokenize(source);
        var pos = 0;
        Token Peek() => tokens[pos];
        bool IsOp(params string[] ops) => Peek().Kind == TokenKind.Op && ops.Contains(Peek().Text);
        bool IsWord(params string[] words) => Peek().Kind == TokenKind.Name && words.Contains(Peek().Text);
        Exception Fail(Token? at = null)
        {
            var token = at ?? Peek();
            return new SyntaxException(token.Start, token.Kind == TokenKind.End ? "The formula ends too soon" : $"Unexpected {token.Text}");
        }
        Token Expect(string op)
        {
            if (!IsOp(op)) throw Fail();
            return tokens[pos++];
        }
        Node Pair(string op, Node left, Node right) => new Binary(op, left, right) { Start = left.Start, End = right.End };

        Node Or()
        {
            var left = And();
            while (IsOp("||") || IsWord("or"))
            {
                pos++;
                left = Pair("or", left, And());
            }
            return left;
        }
        Node And()
        {
            var left = Not();
            while (IsOp("&&") || IsWord("and"))
            {
                pos++;
                left = Pair("and", left, Not());
            }
            return left;
        }
        Node Not()
        {
            if (IsOp("!") || IsWord("not"))
            {
                var start = tokens[pos++].Start;
                var arg = Not();
                return new Unary("not", arg) { Start = start, End = arg.End };
            }
            return Compare();
        }
        Node Compare()
        {
            var left = Add();
            while (IsOp("==", "!=", "<", "<=", ">", ">="))
            {
                var op = tokens[pos++].Text;
                left = Pair(op, left, Add());
            }
            return left;
        }
        Node Add()
        {
            var left = Mul();
            while (IsOp("+", "-"))
            {
                var op = tokens[pos++].Text;
                left = Pair(op, left, Mul());
            }
            return left;
        }
        Node Mul()
        {
            var left = Negate();
            while (IsOp("*", "/", "%"))
            {
                var op = tokens[pos++].Text;
                left = Pair(op, left, Negate());
            }
            return left;
        }
        Node Negate()
        {
            if (IsOp("-"))
            {
                var start = tokens[pos++].Start;
                var arg = Negate();
                return new Unary("-", arg) { Start = start, End = arg.End };
            }
            return Power();
        }
        Node Power()
        {
            var b = Primary();
            if (!IsOp("^")) return b;
            pos++;
            return Pair("^", b, Negate());
        }
        Node Primary()
        {
            var token = Peek();
            if (token.Kind == TokenKind.Number)
            {
                pos++;
                return new Num((double)token.Value!) { Start = token.Start, End = token.End };
            }
            if (token.Kind == TokenKind.String)
            {
                pos++;
                return new Str((string)token.Value!) { Start = token.Start, End = token.End };
            }
            if (IsOp("("))
            {
                pos++;
                var inner = Or();
                var close = Expect(")");
                var copy = inner.Copy();
                copy.Start = token.Start;
                copy.End = close.End;
                return copy;
            }
            if (token.Kind != TokenKind.Name) throw Fail();
            if (token.Text is "true" or "false")
            {
                pos++;
                return new Bool(token.Text == "true") { Start = token.Start, End = token.End };
            }
            if (Keywords.Contains(token.Text)) throw Fail();
            pos++;
            if (!IsOp("(")) throw Fail();
            pos++;
            if (token.Text == "prop")
            {
                var id = Peek();
                if (id.Kind != TokenKind.String) throw Fail(id);
                pos++;
                var close = Expect(")");
                return new Prop((string)id.Value!) { Start = token.Start, End = close.End };
            }
            var args = new List<Node>();
            if (!IsOp(")"))
            {
                args.Add(Or());
                while (IsOp(","))
                {
                    pos++;
                    args.Add(Or());
                }
            }
            var end = Expect(")");
            return new Call(token.Text, args) { Start = token.Start, End = end.End };
        }

        var tree = Or();
        if (Peek().Kind != TokenKind.End) throw Fail();
        return tree;
    }

    // Functions -------------------------------------------------------------------------------------

    public static readonly string[] DateUnits = ["years", "quarters", "months", "weeks", "days", "hours", "minutes"];
    public static readonly string[] DatePatterns = ["YYYY-MM-DD", "YYYY-MM-DD HH:mm", "DD/MM/YYYY", "MM/DD/YYYY"];

    public sealed record Function(string Name, int Min, int? Max, string[][] Args, string Result, int Repeat = 1, (int Index, string[] Values)? Choices = null);

    private static readonly string[] NumberKind = ["number"];
    private static readonly string[] TextKind = ["text"];
    private static readonly string[] DateKind = ["date"];
    private static readonly string[] AnyKind = ["any"];

    public static readonly IReadOnlyList<Function> Functions =
    [
        new("if", 3, 3, [["boolean"], AnyKind, AnyKind], "same"),
        new("ifs", 3, null, [["boolean"], AnyKind], "same", 2),
        new("empty", 1, 1, [AnyKind], "boolean"),
        new("length", 1, 1, [["text", "list"]], "number"),
        new("concat", 1, null, [AnyKind], "text"),
        new("join", 2, null, [TextKind, AnyKind], "text"),
        new("lower", 1, 1, [TextKind], "text"),
        new("upper", 1, 1, [TextKind], "text"),
        new("trim", 1, 1, [TextKind], "text"),
        new("contains", 2, 2, [["text", "list"], TextKind], "boolean"),
        new("replace", 3, 3, [TextKind, TextKind, TextKind], "text"),
        new("replaceAll", 3, 3, [TextKind, TextKind, TextKind], "text"),
        new("slice", 2, 3, [TextKind, NumberKind, NumberKind], "text"),
        new("format", 1, 1, [AnyKind], "text"),
        new("toNumber", 1, 1, [["text", "number", "boolean", "date"]], "number"),
        new("abs", 1, 1, [NumberKind], "number"),
        new("round", 1, 2, [NumberKind, NumberKind], "number"),
        new("floor", 1, 1, [NumberKind], "number"),
        new("ceil", 1, 1, [NumberKind], "number"),
        new("min", 1, null, [NumberKind], "number"),
        new("max", 1, null, [NumberKind], "number"),
        new("sqrt", 1, 1, [NumberKind], "number"),
        new("pow", 2, 2, [NumberKind, NumberKind], "number"),
        new("mod", 2, 2, [NumberKind, NumberKind], "number"),
        new("sign", 1, 1, [NumberKind], "number"),
        new("dateAdd", 3, 3, [DateKind, NumberKind, TextKind], "date", Choices: (2, DateUnits)),
        new("dateSubtract", 3, 3, [DateKind, NumberKind, TextKind], "date", Choices: (2, DateUnits)),
        new("dateBetween", 3, 3, [DateKind, DateKind, TextKind], "number", Choices: (2, DateUnits)),
        new("formatDate", 2, 2, [DateKind, TextKind], "text", Choices: (1, DatePatterns)),
        new("year", 1, 1, [DateKind], "number"),
        new("month", 1, 1, [DateKind], "number"),
        new("day", 1, 1, [DateKind], "number"),
        new("hour", 1, 1, [DateKind], "number"),
        new("minute", 1, 1, [DateKind], "number"),
        new("weekday", 1, 1, [DateKind], "number"),
        new("dateStart", 1, 1, [DateKind], "date"),
        new("dateEnd", 1, 1, [DateKind], "date"),
    ];

    private static readonly Dictionary<string, Function> ByName = Functions.ToDictionary(f => f.Name, StringComparer.Ordinal);

    private static string[] ArgumentKinds(Function fn, int index)
    {
        if (fn.Name == "ifs") return index % 2 == 0 ? ["boolean"] : AnyKind;
        if (index < fn.Args.Length) return fn.Args[index];
        var from = fn.Args.Length - fn.Repeat;
        return fn.Args[from + (index - fn.Args.Length) % fn.Repeat];
    }

    // Checker ---------------------------------------------------------------------------------------

    /// <summary>The kind a property gives formulas, or the error a reference to it gives.</summary>
    public delegate (string? Type, string? Error) PropertyTypeOf(string id);

    private static bool Fits(string type, string[] kinds) => type == "empty" || kinds.Contains("any") || kinds.Contains(type);

    private static FormulaException TypeFail() => new(TypeError);

    private static string Unify(string a, string b)
    {
        if (a == "empty") return b;
        if (b == "empty" || a == b) return a;
        throw TypeFail();
    }

    public static string CheckTree(Node node, PropertyTypeOf typeOf)
    {
        var type = Check(node, typeOf);
        node.Type = type;
        return type;
    }

    private static string Check(Node node, PropertyTypeOf typeOf)
    {
        switch (node)
        {
            case Num: return "number";
            case Str: return "text";
            case Bool: return "boolean";
            case Prop p:
            {
                var (type, error) = typeOf(p.Id);
                if (error is not null) throw new FormulaException(error);
                return type!;
            }
            case Unary u:
            {
                var arg = CheckTree(u.Arg, typeOf);
                if (!Fits(arg, [u.Op == "-" ? "number" : "boolean"])) throw TypeFail();
                return u.Op == "-" ? "number" : "boolean";
            }
            case Binary b:
            {
                var left = CheckTree(b.Left, typeOf);
                var right = CheckTree(b.Right, typeOf);
                switch (b.Op)
                {
                    case "and":
                    case "or":
                        if (!Fits(left, ["boolean"]) || !Fits(right, ["boolean"])) throw TypeFail();
                        return "boolean";
                    case "==":
                    case "!=":
                        if (left == "list" || right == "list") throw TypeFail();
                        Unify(left, right);
                        return "boolean";
                    case "<" or "<=" or ">" or ">=":
                    {
                        var both = Unify(left, right);
                        if (both is "list" or "boolean") throw TypeFail();
                        return "boolean";
                    }
                    case "+":
                        if (left == "text" || right == "text") return "text";
                        if (!Fits(left, ["number"]) || !Fits(right, ["number"])) throw TypeFail();
                        return "number";
                    default:
                        if (!Fits(left, ["number"]) || !Fits(right, ["number"])) throw TypeFail();
                        return "number";
                }
            }
            case Call c:
            {
                if (!ByName.TryGetValue(c.Name, out var fn)) throw new FormulaException(UnknownFunction);
                var n = c.Args.Count;
                if (n < fn.Min || (fn.Max is { } max && n > max) || (fn.Name == "ifs" && n % 2 == 0)) throw new FormulaException(Arity);
                var types = c.Args.Select(arg => CheckTree(arg, typeOf)).ToList();
                for (var i = 0; i < types.Count; i++)
                {
                    var kinds = fn.Name == "ifs" && i == n - 1 ? AnyKind : ArgumentKinds(fn, i);
                    if (!Fits(types[i], kinds)) throw TypeFail();
                }
                if (fn.Choices is { } choices && choices.Index < c.Args.Count && c.Args[choices.Index] is Str s && !choices.Values.Contains(s.Value))
                    throw TypeFail();
                if (fn.Name == "if") return Unify(types[1], types[2]);
                if (fn.Name == "ifs")
                {
                    var result = types[n - 1];
                    for (var i = 1; i < n - 1; i += 2) result = Unify(result, types[i]);
                    return result;
                }
                return fn.Result;
            }
            default:
                throw new FormulaException(Syntax);
        }
    }

    // Compile ---------------------------------------------------------------------------------------

    public sealed class CompiledFormula(PropertyDef def)
    {
        public PropertyDef Def { get; } = def;
        public Node? Tree { get; set; }
        public string? Type { get; set; }
        public string? Error { get; set; }
        public int? At { get; set; }
    }

    public sealed class Compiled
    {
        public required Dictionary<string, PropertyDef> Props { get; init; }
        public required Dictionary<string, CompiledFormula> Formulas { get; init; }
        public required List<string> Order { get; init; }
        public required List<PropertyDef> Rollups { get; init; }
    }

    /// <summary>The kind a rollup gives formulas, filters and sorts.</summary>
    public static string RollupType(string? fn) => fn switch
    {
        "earliest" or "latest" => "date",
        "showOriginal" => "list",
        _ => "number",
    };

    /// <summary>The kind a property of a type gives formulas.</summary>
    public static string TypeOfProperty(string type) => type switch
    {
        PropertyTypes.Number => "number",
        PropertyTypes.Checkbox => "boolean",
        PropertyTypes.Date or PropertyTypes.CreatedTime or PropertyTypes.LastEditedTime => "date",
        PropertyTypes.MultiSelect or PropertyTypes.Person or PropertyTypes.Files or PropertyTypes.Relation or PropertyTypes.CreatedBy or PropertyTypes.LastEditedBy => "list",
        _ => "text",
    };

    private static void PropsOf(Node node, List<string> into)
    {
        switch (node)
        {
            case Prop p:
                if (!into.Contains(p.Id)) into.Add(p.Id);
                break;
            case Unary u:
                PropsOf(u.Arg, into);
                break;
            case Binary b:
                PropsOf(b.Left, into);
                PropsOf(b.Right, into);
                break;
            case Call c:
                foreach (var arg in c.Args) PropsOf(arg, into);
                break;
        }
    }

    public static Compiled Compile(Schema schema)
    {
        var props = new Dictionary<string, PropertyDef>(StringComparer.Ordinal);
        var order = new List<PropertyDef>();
        foreach (var def in schema.Properties)
            if (props.TryAdd(def.Id, def)) order.Add(def);
        var formulas = new Dictionary<string, CompiledFormula>(StringComparer.Ordinal);
        var formulaOrder = new List<string>();
        var reads = new Dictionary<string, List<string>>(StringComparer.Ordinal);
        foreach (var def in order)
        {
            if (def.Type != PropertyTypes.Formula || def.Trashed) continue;
            var expression = def.Expression ?? "";
            var compiled = new CompiledFormula(def);
            if (DbText.Trim(expression).Length == 0) compiled.Type = "empty";
            else
                try
                {
                    compiled.Tree = Parse(expression);
                }
                catch (SyntaxException e)
                {
                    compiled.Error = Syntax;
                    compiled.At = e.At;
                }
            formulas[def.Id] = compiled;
            formulaOrder.Add(def.Id);
            var list = new List<string>();
            if (compiled.Tree is not null) PropsOf(compiled.Tree, list);
            reads[def.Id] = list;
        }

        // Tarjan's strongly connected components: each comes out after every one it reads.
        var result = new List<string>();
        var index = new Dictionary<string, int>(StringComparer.Ordinal);
        var low = new Dictionary<string, int>(StringComparer.Ordinal);
        var stack = new Stack<string>();
        var onStack = new HashSet<string>(StringComparer.Ordinal);
        void Visit(string id)
        {
            index[id] = index.Count;
            low[id] = index[id];
            stack.Push(id);
            onStack.Add(id);
            foreach (var next in reads.GetValueOrDefault(id) ?? [])
            {
                if (!formulas.ContainsKey(next)) continue;
                if (!index.ContainsKey(next))
                {
                    Visit(next);
                    low[id] = Math.Min(low[id], low[next]);
                }
                else if (onStack.Contains(next)) low[id] = Math.Min(low[id], index[next]);
            }
            if (low[id] != index[id]) return;
            var group = new List<string>();
            string member;
            do
            {
                member = stack.Pop();
                onStack.Remove(member);
                group.Add(member);
            }
            while (member != id);
            group.Reverse();
            var cycle = group.Count > 1 || (reads.GetValueOrDefault(id) ?? []).Contains(id);
            foreach (var m in group)
            {
                if (cycle) formulas[m].Error = Cycle;
                result.Add(m);
            }
        }
        foreach (var id in formulaOrder)
            if (!index.ContainsKey(id)) Visit(id);

        (string?, string?) TypeOf(string id)
        {
            if (!props.TryGetValue(id, out var def) || def.Trashed) return (null, UnknownProperty);
            if (def.Type == PropertyTypes.Formula)
            {
                var formula = formulas[id];
                return formula.Error is { } error ? (null, error) : (formula.Type ?? "empty", null);
            }
            if (def.Type == PropertyTypes.Rollup) return (RollupType(def.RollupFunction), null);
            return (TypeOfProperty(def.Type), null);
        }
        foreach (var id in result)
        {
            var formula = formulas[id];
            if (formula.Error is not null || formula.Tree is null) continue;
            try
            {
                formula.Type = CheckTree(formula.Tree, TypeOf);
            }
            catch (FormulaException e)
            {
                formula.Error = e.Code;
            }
        }
        var rollups = order.Where(d => d.Type == PropertyTypes.Rollup && !d.Trashed).ToList();
        return new Compiled { Props = props, Formulas = formulas, Order = result, Rollups = rollups };
    }

    // Evaluate --------------------------------------------------------------------------------------

    /// <summary>A property's value as formulas read it, by its static kind; throws <see cref="FormulaException"/> for an error cell.</summary>
    public delegate object? PropReader(string id, string type);

    private static Exception Fail(string code) => new FormulaException(code);

    private static double Finite(double n) => double.IsFinite(n) ? n : throw Fail(Range);

    private static bool Truthy(object? value) => value is true;

    /// <summary>Any value as text: <c>format</c>.</summary>
    public static string FormatValue(object? value) => value switch
    {
        null => "",
        string s => s,
        double d => JsNumber.ToString(d),
        bool b => b ? "true" : "false",
        string[] list => string.Join(", ", list),
        DateValue date => DbDates.DateText(date),
        _ => "",
    };

    private static string Text(object? value) => value as string ?? FormatValue(value);
    private static double? NumberOf(object? value) => value is double d ? d : null;
    private static DateValue? DateOf(object? value) => value as DateValue;

    private static double StartMs(DateValue value) => DbDates.PointMs(value.Start);

    private static bool Equal(object? a, object? b)
    {
        if (a is null || b is null) return a is null && b is null;
        if (a is DateValue x && b is DateValue y)
            return StartMs(x) == StartMs(y)
                && (!string.IsNullOrEmpty(x.End) ? !string.IsNullOrEmpty(y.End) && DbDates.PointMs(x.End) == DbDates.PointMs(y.End) : string.IsNullOrEmpty(y.End));
        return (a, b) switch
        {
            (double m, double n) => m == n,
            (string m, string n) => m == n,
            (bool m, bool n) => m == n,
            _ => false,
        };
    }

    private static int CompareValues(object a, object b)
    {
        if (a is DateValue x && b is DateValue y) return Math.Sign(StartMs(x) - StartMs(y));
        if (a is double m && b is double n) return m < n ? -1 : m > n ? 1 : 0;
        return string.CompareOrdinal(JsString(a), JsString(b)) switch { < 0 => -1, > 0 => 1, _ => 0 };
    }

    /// <summary>JavaScript's <c>String(x)</c> of a formula value.</summary>
    private static string JsString(object value) => value switch
    {
        string s => s,
        double d => JsNumber.ToString(d),
        bool b => b ? "true" : "false",
        string[] list => string.Join(",", list),
        _ => "[object Object]",
    };

    private static readonly double[] PowersOfTen = Enumerable.Range(0, 16).Select(i => double.Parse("1e" + i, CultureInfo.InvariantCulture)).ToArray();

    private static double Round(double n, double digits)
    {
        var d = Math.Truncate(digits);
        if (Math.Abs(d) > 15) throw Fail(Range);
        var a = Math.Abs(n);
        var r = d >= 0
            ? Math.Floor(a * PowersOfTen[(int)d] + 0.5) / PowersOfTen[(int)d]
            : Math.Floor(a / PowersOfTen[(int)-d] + 0.5) * PowersOfTen[(int)-d];
        return Finite(Math.Sign(n) * r);
    }

    private static string Slice(string t, double? start, double? end)
    {
        var length = t.Length;
        int At(double n)
        {
            var i = Math.Truncate(n);
            return (int)(i < 0 ? Math.Max(length + i, 0) : Math.Min(i, length));
        }
        var from = At(start ?? 0);
        var to = end is null ? length : At(end.Value);
        return from < to ? t[from..to] : "";
    }

    private static string ReplaceFirst(string t, string search, string by)
    {
        if (search.Length == 0) return t;
        var i = t.IndexOf(search, StringComparison.Ordinal);
        return i < 0 ? t : t[..i] + by + t[(i + search.Length)..];
    }

    private static string UnitOf(object? value) =>
        value is string s && DateUnits.Contains(s) ? s : throw Fail(TypeError);

    private static DateValue Shift(DateValue value, double amount, string unit)
    {
        var n = Math.Truncate(amount);
        string? Move(string point) => unit switch
        {
            "years" => DbDates.AddMonths(point, n * 12),
            "quarters" => DbDates.AddMonths(point, n * 3),
            "months" => DbDates.AddMonths(point, n),
            "weeks" => DbDates.AddDays(point, n * 7),
            "days" => DbDates.AddDays(point, n),
            "hours" => DbDates.AddMs(point, n * DbDates.HourMs),
            _ => DbDates.AddMs(point, n * DbDates.MinuteMs),
        };
        var start = Move(value.Start);
        var end = !string.IsNullOrEmpty(value.End) ? Move(value.End) : null;
        if (start is null || (!string.IsNullOrEmpty(value.End) && end is null)) throw Fail(Range);
        return end is null ? new DateValue(start) : new DateValue(start, end);
    }

    private static string AsInstant(string point) => DbDates.IsDateOnly(point) ? point + "T00:00:00Z" : point;

    private static double Digits(string s) => double.Parse(s, CultureInfo.InvariantCulture);

    private static double MonthsBetween(string a, string b)
    {
        var ia = AsInstant(a);
        var ib = AsInstant(b);
        if (DbDates.PointMs(ia) < DbDates.PointMs(ib)) return -MonthsBetween(b, a);
        var months = (Digits(ia[..4]) - Digits(ib[..4])) * 12 + (Digits(ia[5..7]) - Digits(ib[5..7]));
        if (DbDates.PointMs(DbDates.AddMonths(ib, months)!) > DbDates.PointMs(ia)) months -= 1;
        return months;
    }

    private static double Between(DateValue a, DateValue b, string unit)
    {
        var diff = StartMs(a) - StartMs(b);
        return unit switch
        {
            "minutes" => Math.Truncate(diff / DbDates.MinuteMs),
            "hours" => Math.Truncate(diff / DbDates.HourMs),
            "days" => Math.Truncate(diff / DbDates.DayMs),
            "weeks" => Math.Truncate(diff / (7.0 * DbDates.DayMs)),
            "months" => MonthsBetween(a.Start, b.Start),
            "quarters" => Math.Truncate(MonthsBetween(a.Start, b.Start) / 3),
            _ => Math.Truncate(MonthsBetween(a.Start, b.Start) / 12),
        };
    }

    private static string PatternOf(object? value) =>
        value is string s && DatePatterns.Contains(s) ? s : throw Fail(TypeError);

    private static string FormatDate(DateValue value, string pattern)
    {
        var s = AsInstant(value.Start);
        var (y, m, d) = (s[..4], s[5..7], s[8..10]);
        return pattern switch
        {
            "YYYY-MM-DD HH:mm" => $"{y}-{m}-{d} {s[11..13]}:{s[14..16]}",
            "DD/MM/YYYY" => $"{d}/{m}/{y}",
            "MM/DD/YYYY" => $"{m}/{d}/{y}",
            _ => $"{y}-{m}-{d}",
        };
    }

    private static double Part(DateValue value, string which)
    {
        var s = AsInstant(value.Start);
        return which switch
        {
            "year" => Digits(s[..4]),
            "month" => Digits(s[5..7]),
            "day" => Digits(s[8..10]),
            "hour" => Digits(s[11..13]),
            "minute" => Digits(s[14..16]),
            _ => DbDates.WeekdayOfDay(DbDates.DateDay(s[..10])),
        };
    }

    /// <summary>Evaluates a checked tree; throws <see cref="FormulaException"/>.</summary>
    public static object? Evaluate(Node node, PropReader prop)
    {
        switch (node)
        {
            case Num n: return Finite(n.Value);
            case Str s: return s.Value;
            case Bool b: return b.Value;
            case Prop p: return prop(p.Id, p.Type ?? "empty");
            case Unary u:
            {
                var value = Evaluate(u.Arg, prop);
                if (u.Op == "not") return !Truthy(value);
                return value is null ? null : Finite(-(value is double d ? d : double.NaN));
            }
            case Binary b: return BinaryValue(b, prop);
            case Call c: return CallValue(c, prop);
            default: throw Fail(Syntax);
        }
    }

    private static object? BinaryValue(Binary node, PropReader prop)
    {
        if (node.Op == "and") return Truthy(Evaluate(node.Left, prop)) && Truthy(Evaluate(node.Right, prop));
        if (node.Op == "or") return Truthy(Evaluate(node.Left, prop)) || Truthy(Evaluate(node.Right, prop));
        var left = Evaluate(node.Left, prop);
        var right = Evaluate(node.Right, prop);
        switch (node.Op)
        {
            case "==": return Equal(left, right);
            case "!=": return !Equal(left, right);
            case "<" or "<=" or ">" or ">=":
            {
                if (left is null || right is null) return false;
                var c = CompareValues(left, right);
                return node.Op switch { "<" => c < 0, "<=" => c <= 0, ">" => c > 0, _ => c >= 0 };
            }
            case "+" when node.Type == "text":
                return FormatValue(left) + FormatValue(right);
        }
        var a = NumberOf(left);
        var b = NumberOf(right);
        if (a is null || b is null) return null;
        switch (node.Op)
        {
            case "+": return Finite(a.Value + b.Value);
            case "-": return Finite(a.Value - b.Value);
            case "*": return Finite(a.Value * b.Value);
            case "/":
                if (b.Value == 0) throw Fail(DivideByZero);
                return Finite(a.Value / b.Value);
            case "%":
                if (b.Value == 0) throw Fail(DivideByZero);
                return Finite(a.Value % b.Value);
            default:
                return Finite(Math.Pow(a.Value, b.Value));
        }
    }

    private static object? CallValue(Call node, PropReader prop)
    {
        var args = node.Args;
        if (node.Name == "if") return Truthy(Evaluate(args[0], prop)) ? Evaluate(args[1], prop) : Evaluate(args[2], prop);
        if (node.Name == "ifs")
        {
            for (var i = 0; i + 1 < args.Count; i += 2)
                if (Truthy(Evaluate(args[i], prop))) return Evaluate(args[i + 1], prop);
            return Evaluate(args[^1], prop);
        }
        var v = args.Select(arg => Evaluate(arg, prop)).ToList();
        bool IsList(int i) => args[i].Type == "list" || v[i] is string[];
        var n0 = NumberOf(v[0]);
        object? UnaryNumber(Func<double, double> fn) => n0 is null ? null : Finite(fn(n0.Value));
        switch (node.Name)
        {
            case "empty":
                return v[0] is null || v[0] is "" || v[0] is string[] { Length: 0 };
            case "length":
                return v[0] is string[] l ? (double)l.Length : (double)Text(v[0]).Length;
            case "concat":
                return string.Concat(v.Select(FormatValue));
            case "join":
            {
                var items = new List<string>();
                foreach (var value in v.Skip(1))
                    foreach (var item in value is string[] list ? list.Cast<object?>() : [value])
                    {
                        var t = FormatValue(item);
                        if (t.Length > 0) items.Add(t);
                    }
                return string.Join(Text(v[0]), items);
            }
            case "lower": return DbText.Lower(Text(v[0]));
            case "upper": return DbText.Upper(Text(v[0]));
            case "trim": return DbText.Trim(Text(v[0]));
            case "contains":
                if (IsList(0)) return v[0] is string[] list && list.Contains(Text(v[1]), StringComparer.Ordinal);
                return Text(v[0]).Contains(Text(v[1]), StringComparison.Ordinal);
            case "replace":
                return ReplaceFirst(Text(v[0]), Text(v[1]), Text(v[2]));
            case "replaceAll":
            {
                var search = Text(v[1]);
                return search.Length == 0 ? Text(v[0]) : Text(v[0]).Replace(search, Text(v[2]), StringComparison.Ordinal);
            }
            case "slice":
                return Slice(Text(v[0]), NumberOf(v[1]), args.Count > 2 ? NumberOf(v[2]) : null);
            case "format":
                return FormatValue(v[0]);
            case "toNumber":
                return v[0] switch
                {
                    double d => d,
                    string s => DbText.ParseNumber(s),
                    bool b => b ? 1.0 : 0.0,
                    DateValue date => StartMs(date),
                    _ => null,
                };
            case "abs": return UnaryNumber(Math.Abs);
            case "floor": return UnaryNumber(Math.Floor);
            case "ceil": return UnaryNumber(Math.Ceiling);
            case "sqrt": return UnaryNumber(Math.Sqrt);
            case "sign": return UnaryNumber(x => Math.Sign(x));
            case "round":
            {
                if (n0 is null) return null;
                var digits = args.Count > 1 ? NumberOf(v[1]) : 0;
                return digits is null ? null : Round(n0.Value, digits.Value);
            }
            case "min":
            case "max":
            {
                var numbers = v.OfType<double>().ToList();
                if (numbers.Count == 0) return null;
                return node.Name == "min" ? JsMin(numbers) : JsMax(numbers);
            }
            case "pow":
            {
                var b = NumberOf(v[1]);
                return n0 is null || b is null ? null : Finite(Math.Pow(n0.Value, b.Value));
            }
            case "mod":
            {
                var b = NumberOf(v[1]);
                if (n0 is null || b is null) return null;
                if (b.Value == 0) throw Fail(DivideByZero);
                var r = n0.Value % b.Value;
                if (r != 0 && (r < 0) != (b.Value < 0)) r += b.Value;
                return Finite(r);
            }
            case "dateAdd":
            case "dateSubtract":
            {
                var d = DateOf(v[0]);
                var amount = NumberOf(v[1]);
                var unit = UnitOf(v[2]);
                if (d is null || amount is null) return null;
                return Shift(d, node.Name == "dateAdd" ? amount.Value : -amount.Value, unit);
            }
            case "dateBetween":
            {
                var a = DateOf(v[0]);
                var b = DateOf(v[1]);
                var unit = UnitOf(v[2]);
                return a is not null && b is not null ? Between(a, b, unit) : null;
            }
            case "formatDate":
            {
                var pattern = PatternOf(v[1]);
                var d = DateOf(v[0]);
                return d is null ? null : FormatDate(d, pattern);
            }
            case "year" or "month" or "day" or "hour" or "minute" or "weekday":
            {
                var d = DateOf(v[0]);
                return d is null ? null : Part(d, node.Name);
            }
            case "dateStart":
                return DateOf(v[0]) is { } start ? new DateValue(start.Start) : null;
            case "dateEnd":
                return DateOf(v[0]) is { } end ? new DateValue(string.IsNullOrEmpty(end.End) ? end.Start : end.End) : null;
            default:
                throw Fail(UnknownFunction);
        }
    }

    /// <summary>JavaScript's <c>Math.min</c> and <c>Math.max</c> (−0 below +0).</summary>
    private static double JsMin(List<double> numbers)
    {
        var best = numbers[0];
        foreach (var n in numbers.Skip(1))
            if (n < best || (n == 0 && best == 0 && double.IsNegative(n))) best = n;
        return best;
    }

    private static double JsMax(List<double> numbers)
    {
        var best = numbers[0];
        foreach (var n in numbers.Skip(1))
            if (n > best || (n == 0 && best == 0 && !double.IsNegative(n))) best = n;
        return best;
    }

    /// <summary>A result as stored: '' and [] are empty, -0 is 0.</summary>
    public static object? Finish(object? value)
    {
        if (value is "" || value is string[] { Length: 0 }) return null;
        if (value is double d && d == 0) return 0.0;
        return value;
    }

    /// <summary>The ids of <c>prop("...")</c> rewritten (formula/names.ts); an expression that does not tokenise stays.</summary>
    private static string Rewrite(string expression, Func<string, string?> replace)
    {
        List<Token> tokens;
        try
        {
            tokens = Tokenize(expression);
        }
        catch (SyntaxException)
        {
            return expression;
        }
        var output = new StringBuilder();
        var last = 0;
        for (var i = 0; i + 3 < tokens.Count; i++)
        {
            var (name, open, arg, close) = (tokens[i], tokens[i + 1], tokens[i + 2], tokens[i + 3]);
            if (name.Kind != TokenKind.Name || name.Text != "prop") continue;
            if (open.Text != "(" || arg.Kind != TokenKind.String || close.Text != ")") continue;
            if (replace((string)arg.Value!) is not { } next) continue;
            output.Append(expression, last, arg.Start - last).Append('"').Append(next.Replace("\\", "\\\\").Replace("\"", "\\\"")).Append('"');
            last = arg.End;
        }
        return output.Append(expression, last, expression.Length - last).ToString();
    }

    /// <summary><c>prop("id")</c> as <c>prop("Name")</c>; ids the database does not have stay.</summary>
    public static string ToNames(Schema schema, string expression) => Rewrite(expression, id => schema[id]?.Name);

    /// <summary><c>prop("Name")</c> as <c>prop("id")</c>: the first property with the name, one not deleted before a deleted one.</summary>
    public static string ToIds(Schema schema, string expression) => Rewrite(expression, name =>
        (schema.Properties.FirstOrDefault(d => !d.Trashed && d.Name == name) ?? schema.Properties.FirstOrDefault(d => d.Trashed && d.Name == name))?.Id);
}
