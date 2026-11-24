namespace Cgw.Core.Forms;

/// <summary>
/// A form link's own words (Phase 16), in the form's language: English or Arabic. The form's own
/// title, questions and thank-you text are its editor's; these are the rest.
/// </summary>
public sealed class FormWords
{
    public required string Language { get; init; }
    public required string Direction { get; init; }
    public required string Skip { get; init; }
    public required string Next { get; init; }
    public required string Back { get; init; }
    public required string Submit { get; init; }
    public required string Choose { get; init; }
    public required string RequiredNote { get; init; }
    public required string Required { get; init; }
    public required string Thanks { get; init; }
    public required string Again { get; init; }
    public required string Off { get; init; }
    public required string Closed { get; init; }
    public required string Full { get; init; }
    public required string NoQuestions { get; init; }
    public required string CheckThese { get; init; }
    public required string Refused { get; init; }
    public required string Trap { get; init; }
    public required string Footer { get; init; }
    public required string Untitled { get; init; }
    /// <summary>Why an answer is refused, by its reason (<c>answer.required</c>, ...).</summary>
    public required IReadOnlyDictionary<string, string> Problems { get; init; }

    public static readonly FormWords English = new()
    {
        Language = "en",
        Direction = "ltr",
        Skip = "Skip to the form",
        Next = "Next",
        Back = "Back",
        Submit = "Submit",
        Choose = "Choose…",
        RequiredNote = "Questions marked * are required.",
        Required = "Required",
        Thanks = "Thank you. Your answer was sent.",
        Again = "Send another answer",
        Off = "This form is not taking answers.",
        Closed = "This form is closed.",
        Full = "This form has all the answers it takes.",
        NoQuestions = "This form has no questions yet.",
        CheckThese = "Check these answers:",
        Refused = "Your answer could not be taken. Check it and send it again.",
        Trap = "Leave this empty",
        Footer = "Made with Cash Gear Workspace",
        Untitled = "Untitled form",
        Problems = new Dictionary<string, string>(StringComparer.Ordinal)
        {
            ["answer.required"] = "Answer this question.",
            ["answer.invalid"] = "This is not an answer this question takes.",
            ["answer.option"] = "Choose one of the options shown.",
            ["answer.long"] = "This answer is too long.",
            ["answer.empty"] = "Answer at least one question.",
        },
    };

    public static readonly FormWords Arabic = new()
    {
        Language = "ar",
        Direction = "rtl",
        Skip = "انتقل إلى النموذج",
        Next = "التالي",
        Back = "السابق",
        Submit = "إرسال",
        Choose = "اختر…",
        RequiredNote = "الأسئلة المعلّمة بـ * مطلوبة.",
        Required = "مطلوب",
        Thanks = "شكرًا لك. أُرسلت إجابتك.",
        Again = "أرسل إجابة أخرى",
        Off = "لا يستقبل هذا النموذج إجابات.",
        Closed = "أُغلق هذا النموذج.",
        Full = "اكتملت الإجابات التي يستقبلها هذا النموذج.",
        NoQuestions = "لا أسئلة في هذا النموذج بعد.",
        CheckThese = "راجع هذه الإجابات:",
        Refused = "تعذّر قبول إجابتك. راجعها وأرسلها مرة أخرى.",
        Trap = "اترك هذا فارغًا",
        Footer = "صُنع باستخدام Cash Gear Workspace",
        Untitled = "نموذج بلا عنوان",
        Problems = new Dictionary<string, string>(StringComparer.Ordinal)
        {
            ["answer.required"] = "أجب عن هذا السؤال.",
            ["answer.invalid"] = "هذه ليست إجابة يقبلها هذا السؤال.",
            ["answer.option"] = "اختر أحد الخيارات المعروضة.",
            ["answer.long"] = "هذه الإجابة طويلة جدًا.",
            ["answer.empty"] = "أجب عن سؤال واحد على الأقل.",
        },
    };

    public static FormWords For(string? language) => language == "ar" ? Arabic : English;

    public string Problem(string reason) => Problems.TryGetValue(reason, out var text) ? text : Problems["answer.invalid"];
}
