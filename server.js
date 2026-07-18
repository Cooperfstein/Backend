require("dotenv").config();

const express = require("express");
const cors = require("cors");

const app = express();

app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

const ADZUNA_APP_ID = process.env.ADZUNA_APP_ID;
const ADZUNA_APP_KEY = process.env.ADZUNA_APP_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

console.log({
  adzunaID: !!ADZUNA_APP_ID,
  adzunaKey: !!ADZUNA_APP_KEY,
  anthropic: !!ANTHROPIC_API_KEY
});


app.get("/", (req, res) => {
  res.send("Job matcher backend is running.");
});


app.post("/api/match", async (req, res) => {

  try {

    const {
      age,
      zip,
      hobbies = [],
      skills = [],
      wage,
      hoursPerWeek
    } = req.body;


    if (!zip) {
      return res.status(400).json({
        error: "Zip code required"
      });
    }


    if (!ADZUNA_APP_ID || !ADZUNA_APP_KEY || !ANTHROPIC_API_KEY) {

      return res.status(500).json({
        error: "Missing API keys"
      });

    }


    /*
      STEP 1:
      Get jobs from Adzuna

      Keep search broad.
      Claude does the matching.
    */


    const searchTerm = "part time";


    let url =
      `https://api.adzuna.com/v1/api/jobs/us/search/1` +
      `?app_id=${ADZUNA_APP_ID}` +
      `&app_key=${ADZUNA_APP_KEY}` +
      `&results_per_page=25` +
      `&where=${encodeURIComponent(zip)}` +
      `&what=${encodeURIComponent(searchTerm)}`;


    if (hoursPerWeek && Number(hoursPerWeek) <= 25) {
      url += "&part_time=1";
    }


    console.log("Adzuna URL:");
    console.log(url);


    const adzunaResponse = await fetch(url);


    if (!adzunaResponse.ok) {

      const error = await adzunaResponse.text();

      throw new Error(
        "Adzuna failed: " + error
      );

    }


    const adzunaData = await adzunaResponse.json();


    console.log(
      "Jobs returned:",
      adzunaData.results?.length
    );


    const jobs =
      (adzunaData.results || []).map(job => ({
        
        title:
          job.title || "Unknown job",

        company:
          job.company?.display_name || "Unknown company",

        location:
          job.location?.display_name || "",

        salary_min:
          job.salary_min || null,

        salary_max:
          job.salary_max || null,

        contract_time:
          job.contract_time || "",

        description:
          (job.description || "")
          .replace(/<[^>]*>/g,"")
          .slice(0,400),

        url:
          job.redirect_url

      }));



    if (jobs.length === 0) {

      return res.json({
        matches:[]
      });

    }



    /*
      STEP 2:
      Ask Claude to rank jobs
    */


    const jobText = jobs
      .map((job,index)=>{

        return `
JOB ${index+1}

Title:
${job.title}

Company:
${job.company}

Location:
${job.location}

Pay:
${job.salary_min || "unknown"}

Description:
${job.description}

`;

      })
      .join("\n");



    const prompt = `

You match teenagers with first jobs.

User:

Age:
${age}

Hobbies:
${hobbies.join(", ")}

Skills:
${skills.join(", ")}

Desired pay:
${wage || "unknown"}

Hours:
${hoursPerWeek || "unknown"}


Jobs:

${jobText}


Rank the best 10 jobs.

Return ONLY JSON.

Format:

[
{
"index":1,
"matchScore":90,
"reason":"why this fits"
}
]

`;



    const claudeResponse = await fetch(
      "https://api.anthropic.com/v1/messages",
      {

        method:"POST",

        headers:{
          "Content-Type":"application/json",
          "x-api-key":ANTHROPIC_API_KEY,
          "anthropic-version":"2023-06-01"
        },


        body:JSON.stringify({

          model:"claude-sonnet-4-20250514",

          max_tokens:2000,

          messages:[
            {
              role:"user",
              content:prompt
            }
          ]

        })

      }
    );



    if(!claudeResponse.ok){

      const error =
        await claudeResponse.text();

      throw new Error(
        "Claude failed: " + error
      );

    }



    const claudeData =
      await claudeResponse.json();


    let text =
      claudeData.content
      .map(x=>x.text)
      .join("");



    text =
      text
      .replace(/```json/g,"")
      .replace(/```/g,"")
      .trim();



    let rankings;


    try{

      rankings =
        JSON.parse(text);

    }

    catch(error){

      console.log(
        "Claude JSON ERROR:",
        text
      );

      throw new Error(
        "Claude returned invalid JSON"
      );

    }



    const matches =
      rankings
      .map(rank=>{

        const job =
          jobs[rank.index-1];

        if(!job)
          return null;


        return {

          ...job,

          matchScore:
            rank.matchScore,

          reason:
            rank.reason

        };

      })
      .filter(Boolean);



    res.json({
      matches
    });


  }


  catch(error){

    console.error(error);

    res.status(500).json({

      error:error.message

    });

  }


});



app.listen(PORT,()=>{

  console.log(
    `Backend running on port ${PORT}`
  );

});