using System.Globalization;
using System.Text.RegularExpressions;
using PiTravel.Server.Contracts;

namespace PiTravel.Server.Planning;

/// <summary>
/// Start-date and day-count rules, mirroring <c>validateBrief</c> in
/// <c>apps/server/src/plan/validate.ts</c>. Dates are compared as
/// <c>yyyy-MM-dd</c> strings, exactly as the TypeScript does.
/// </summary>
public static class BriefValidator
{
    private static readonly Regex IsoDatePattern =
        new("^[0-9]{4}-[0-9]{2}-[0-9]{2}$", RegexOptions.CultureInvariant);

    /// <summary>Whether a YYYY-MM-DD string names a real calendar day.</summary>
    public static bool IsValidCalendarDate(string value)
    {
        if (!IsoDatePattern.IsMatch(value)) return false;

        var parts = value.Split('-');
        var year = int.Parse(parts[0], CultureInfo.InvariantCulture);
        var month = int.Parse(parts[1], CultureInfo.InvariantCulture);
        var day = int.Parse(parts[2], CultureInfo.InvariantCulture);

        // JavaScript's Date.UTC maps years 0-99 to 1900-1999, so the round-trip
        // check in validate.ts rejects them; keep that behavior.
        if (year < 100) return false;
        if (month is < 1 or > 12) return false;
        return day >= 1 && day <= DateTime.DaysInMonth(year, month);
    }

    public static IReadOnlyList<string> Validate(
        TripBrief brief,
        DateTimeOffset now,
        bool requireComplete = true)
    {
        var errors = new List<string>();

        if (requireComplete) errors.AddRange(BriefRules.MissingFields(brief));

        if (brief.StartDate is { Length: > 0 } startDate)
        {
            if (!IsValidCalendarDate(startDate))
            {
                errors.Add("startDate must be a real calendar date (YYYY-MM-DD)");
            }
            else if (string.CompareOrdinal(startDate, IsoDateOf(now)) < 0)
            {
                errors.Add("startDate must not be in the past");
            }
        }

        if (brief.Days is double days && (days % 1 != 0 || days < 1))
        {
            errors.Add("days must be at least 1");
        }

        return errors;
    }

    private static string IsoDateOf(DateTimeOffset now) =>
        now.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);
}
